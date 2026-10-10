import { Injectable } from '@nestjs/common';
import type { ClubEntry, ClubEntryPlayer, Tournament } from '@prisma/client';
import { AGE_BAND_MIN, ageOn } from '../../common/time/local-time';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ProblemDto } from './dto/tournament.dto';
import type { SquadCountsDto } from './dto/entries.dto';
import { analyseSchedule } from './logic/scheduler';

export type AgeEligibility = 'ELIGIBLE' | 'EXCEPTION_REQUIRED' | 'NOT_ALLOWED' | 'UNKNOWN_DOB';

/** Age is evaluated on the tournament's start date in its timezone (published, does not drift). */
export function tournamentAgeEligibility(
  dateOfBirth: Date | null,
  t: Pick<Tournament, 'ageBand' | 'allowYounger' | 'startsOn' | 'timezone'>,
): AgeEligibility {
  const min = AGE_BAND_MIN[t.ageBand];
  if (min === 0) return 'ELIGIBLE';
  if (!dateOfBirth) return 'UNKNOWN_DOB';
  const reference = new Date(t.startsOn.getTime() + 12 * 3_600_000);
  if (ageOn(dateOfBirth, reference, t.timezone) >= min) return 'ELIGIBLE';
  return t.allowYounger ? 'EXCEPTION_REQUIRED' : 'NOT_ALLOWED';
}

export interface MandatoryDoc {
  id: string;
  title: string;
  audience: 'CLUB_REPS' | 'PLAYERS' | 'BOTH';
  versionId: string;
  version: number;
}

export interface PlayerReadiness {
  userId: string;
  eligibility: AgeEligibility;
  ageExceptionApproved: boolean;
  missingDocumentIds: string[];
  /** Confirmed, admitted by age and accepted every mandatory player document. */
  admitted: boolean;
}

export interface EntryReadiness {
  entryId: string;
  ready: boolean;
  problems: ProblemDto[];
  squad: SquadCountsDto;
  repMissingDocumentIds: string[];
  players: Map<string, PlayerReadiness>;
}

/**
 * "Accepted" is not "Ready" (Decisions §44.5): a club is Ready only when the organiser accepted
 * it, its representative accepted his own documents, and at least the minimum number of players
 * confirmed, are admitted by age, and personally accepted every mandatory player document.
 * Payment is reported separately and never part of sporting readiness.
 */
@Injectable()
export class ReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async mandatoryDocs(db: Db, tournamentId: string): Promise<MandatoryDoc[]> {
    const docs = await db.ruleDocument.findMany({
      where: { tournamentId, mandatory: true, currentVersionId: { not: null } },
      include: { versions: { select: { id: true, version: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return docs.flatMap((d) => {
      const v = d.versions.find((x) => x.id === d.currentVersionId);
      return v
        ? [{ id: d.id, title: d.title, audience: d.audience, versionId: v.id, version: v.version }]
        : [];
    });
  }

  async consentKeys(db: Db, versionIds: string[], userIds: string[]): Promise<Set<string>> {
    if (versionIds.length === 0 || userIds.length === 0) return new Set();
    const rows = await db.consent.findMany({
      where: { versionId: { in: versionIds }, userId: { in: userIds } },
      select: { versionId: true, userId: true },
    });
    return new Set(rows.map((r) => `${r.versionId}:${r.userId}`));
  }

  /** Readiness of ACCEPTED entries (others get `ready: false` with no problems computed). */
  async forEntries(
    db: Db,
    t: Tournament,
    entries: (ClubEntry & { players: ClubEntryPlayer[] })[],
  ): Promise<Map<string, EntryReadiness>> {
    const docs = await this.mandatoryDocs(db, t.id);
    const repDocs = docs.filter((d) => d.audience !== 'PLAYERS');
    const playerDocs = docs.filter((d) => d.audience !== 'CLUB_REPS');

    const userIds = [
      ...new Set(entries.flatMap((e) => [e.submittedById, ...e.players.map((p) => p.userId)])),
    ];
    const consented = await this.consentKeys(
      db,
      docs.map((d) => d.versionId),
      userIds,
    );
    const profiles = await db.profile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, dateOfBirth: true },
    });
    const dob = new Map(profiles.map((p) => [p.userId, p.dateOfBirth]));

    const fixtures = await db.fixture.findMany({
      where: {
        tournamentId: t.id,
        startsAt: { not: null },
        endsAt: { not: null },
        status: { notIn: ['CANCELLED', 'POSTPONED'] },
      },
      select: {
        id: true,
        homeEntryId: true,
        awayEntryId: true,
        startsAt: true,
        endsAt: true,
        pitchId: true,
      },
    });

    const out = new Map<string, EntryReadiness>();
    for (const e of entries) {
      const players = new Map<string, PlayerReadiness>();
      const active = e.players.filter((p) => p.status === 'INVITED' || p.status === 'CONFIRMED');
      for (const p of active) {
        const eligibility = tournamentAgeEligibility(dob.get(p.userId) ?? null, t);
        const approved = p.ageExceptionApprovedById !== null;
        const missing = playerDocs
          .filter((d) => !consented.has(`${d.versionId}:${p.userId}`))
          .map((d) => d.id);
        players.set(p.userId, {
          userId: p.userId,
          eligibility,
          ageExceptionApproved: approved,
          missingDocumentIds: missing,
          admitted:
            p.status === 'CONFIRMED' &&
            (eligibility === 'ELIGIBLE' || (eligibility === 'EXCEPTION_REQUIRED' && approved)) &&
            missing.length === 0,
        });
      }
      const confirmed = active.filter((p) => p.status === 'CONFIRMED').length;
      const invited = active.filter((p) => p.status === 'INVITED').length;
      const eligible = [...players.values()].filter((p) => p.admitted).length;
      const repMissing = repDocs
        .filter((d) => !consented.has(`${d.versionId}:${e.submittedById}`))
        .map((d) => d.id);
      const min = t.minPlayersPerClub ?? null;

      const problems: ProblemDto[] = [];
      if (e.status === 'ACCEPTED') {
        if (repMissing.length > 0) {
          problems.push({
            code: 'REP_CONSENT_MISSING',
            message: `The club representative has not accepted ${repMissing.length} mandatory document(s)`,
            entryId: e.id,
            clubId: e.clubId,
            userId: e.submittedById,
          });
        }
        if (eligible < (min ?? 1)) {
          problems.push({
            code: 'SQUAD_TOO_SMALL',
            message: `Only ${eligible} admitted player(s); at least ${min ?? 1} needed`,
            entryId: e.id,
            clubId: e.clubId,
          });
        }
        const slots = fixtures
          .filter((f) => f.homeEntryId === e.id || f.awayEntryId === e.id)
          .map((f) => ({
            id: f.id,
            pitchId: null,
            start: (f.startsAt as Date).getTime(),
            end: (f.endsAt as Date).getTime(),
            clubs: [e.id],
          }));
        for (const c of analyseSchedule(slots, 0).conflicts) {
          problems.push({
            code: 'SCHEDULE_CONFLICT',
            message: c.message,
            entryId: e.id,
            clubId: e.clubId,
            fixtureId: c.fixtureIds[1],
          });
        }
      }
      out.set(e.id, {
        entryId: e.id,
        ready: e.status === 'ACCEPTED' && problems.length === 0,
        problems,
        squad: { confirmed, invited, eligible, min, max: t.maxPlayersPerClub ?? null },
        repMissingDocumentIds: repMissing,
        players,
      });
    }
    return out;
  }
}
