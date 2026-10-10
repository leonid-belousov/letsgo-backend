import { Injectable } from '@nestjs/common';
import type { Club, ClubEntry, ClubEntryPlayer, Tournament } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { clampPageSize, decodeCursor, toPage } from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { isUniqueViolation, type Db, type Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { VisibilityService } from '../privacy/visibility.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import type {
  AgeExceptionDecisionDto,
  DecideEntryDto,
  EnterTournamentDto,
  EntryDto,
  EntryListQuery,
  EntryPageDto,
  InviteClubDto,
  InvitePlayersDto,
  InvitePlayersResultDto,
  MyPlayerDto,
  RespondInvitationDto,
  SquadDto,
  SquadPlayerDto,
} from './dto/entries.dto';
import {
  ReadinessService,
  tournamentAgeEligibility,
  type EntryReadiness,
} from './readiness.service';
import {
  ACTIVE_ENTRY,
  NOT_AVAILABLE,
  TERMINAL,
  TournamentAccess,
  lockTournament,
} from './tournament-access.service';
import { settleObligations } from './tournament-support';

type EntryRow = ClubEntry & {
  club: Pick<Club, 'id' | 'name' | 'username'>;
  players: ClubEntryPlayer[];
};
const ENTRY_INCLUDE = {
  club: { select: { id: true, name: true, username: true } },
  players: true,
} as const;

const DENIED = 'You no longer have access to this action.';

@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly readiness: ReadinessService,
    private readonly payments: PaymentsService,
    private readonly visibility: VisibilityService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── helpers ─────────────

  private async loadEntry(db: Db, tournamentId: string, entryId: string): Promise<EntryRow> {
    const e = await db.clubEntry.findUnique({ where: { id: entryId }, include: ENTRY_INCLUDE });
    if (!e || e.tournamentId !== tournamentId)
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return e;
  }

  private async mayActForClub(db: Db, userId: string, clubId: string): Promise<boolean> {
    return (
      (await this.policy.can(userId, 'club.tournaments.enter', { type: 'CLUB', id: clubId }, db)) ||
      (await this.policy.can(userId, 'club.squad.manage', { type: 'CLUB', id: clubId }, db))
    );
  }

  private async assertRep(db: Db, userId: string, clubId: string): Promise<void> {
    await this.policy.assert(userId, 'club.tournaments.enter', { type: 'CLUB', id: clubId }, db);
  }

  private async assertSquadManager(db: Db, userId: string, clubId: string): Promise<void> {
    if (!(await this.mayActForClub(db, userId, clubId))) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, DENIED);
    }
  }

  private async takenSpots(tx: Tx, tournamentId: string, exceptEntryId?: string): Promise<number> {
    return tx.clubEntry.count({
      where: {
        tournamentId,
        status: { in: ['ACCEPTED', 'INVITED'] },
        ...(exceptEntryId ? { id: { not: exceptEntryId } } : {}),
      },
    });
  }

  private async toDto(
    db: Db,
    t: Tournament,
    rows: EntryRow[],
    withReadiness: (e: EntryRow) => boolean,
  ): Promise<EntryDto[]> {
    const accepted = rows.filter((e) => e.status === 'ACCEPTED');
    const r = await this.readiness.forEntries(db, t, accepted.length ? accepted : []);
    const anyRows = rows.filter((e) => e.status !== 'ACCEPTED');
    const others = anyRows.length
      ? await this.readiness.forEntries(db, t, anyRows)
      : new Map<string, EntryReadiness>();
    return rows.map((e) => {
      const rd = r.get(e.id) ?? (others.get(e.id) as EntryReadiness);
      const show = withReadiness(e);
      return {
        id: e.id,
        tournamentId: e.tournamentId,
        club: e.club,
        status: e.status,
        submittedById: e.submittedById,
        decidedById: e.decidedById,
        createdAt: e.createdAt.toISOString(),
        decidedAt: e.decidedAt?.toISOString() ?? null,
        squad: rd.squad,
        ready: show && e.status === 'ACCEPTED' ? rd.ready : null,
        problems: show && e.status === 'ACCEPTED' ? rd.problems : [],
      };
    });
  }

  private async one(db: Db, viewerId: string, t: Tournament, entryId: string): Promise<EntryDto> {
    const row = await this.loadEntry(db, t.id, entryId);
    const [dto] = await this.toDto(db, t, [row], () => true);
    return dto as EntryDto;
  }

  private async releaseEntry(tx: Tx, e: EntryRow, actorId: string, reason: string): Promise<void> {
    const playerIds = e.players
      .filter((p) => ['INVITED', 'CONFIRMED'].includes(p.status))
      .map((p) => p.userId);
    await tx.clubEntryPlayer.updateMany({
      where: { entryId: e.id, status: { in: ['INVITED', 'CONFIRMED'] } },
      data: { status: 'REMOVED' },
    });
    await settleObligations(
      tx,
      {
        tournamentId: e.tournamentId,
        OR: [
          { kind: 'TOURNAMENT_CLUB_FEE', payerClubId: e.clubId },
          { kind: 'TOURNAMENT_PLAYER_FEE', payerUserId: { in: playerIds } },
        ],
      },
      actorId,
      reason,
    );
  }

  private async ensureFees(tx: Tx, t: Tournament, e: EntryRow): Promise<void> {
    if (t.feeMode === 'PER_CLUB') {
      await this.payments.ensureTournamentObligation(tx, {
        kind: 'TOURNAMENT_CLUB_FEE',
        tournamentId: t.id,
        payerClubId: e.clubId,
        amountMinor: t.feeMinor,
        currency: t.currency,
      });
    } else if (t.feeMode === 'PER_PLAYER') {
      const confirmed = await tx.clubEntryPlayer.findMany({
        where: { entryId: e.id, status: 'CONFIRMED' },
      });
      for (const p of confirmed) {
        await this.payments.ensureTournamentObligation(tx, {
          kind: 'TOURNAMENT_PLAYER_FEE',
          tournamentId: t.id,
          payerUserId: p.userId,
          amountMinor: t.feeMinor,
          currency: t.currency,
        });
      }
    }
  }

  private async notifyClub(
    tx: Tx,
    t: Tournament,
    clubId: string,
    actorId: string,
    title: string,
    kind: string,
    entryId: string,
  ) {
    await this.notifier.notify(tx, {
      recipientIds: await this.access.clubRepresentatives(tx, clubId),
      category: 'tournament',
      activityKind: kind,
      title,
      objectType: 'ClubEntry',
      objectId: entryId,
      actorId,
      essential: true,
      payload: { tournamentId: t.id, entryId },
      dedupeKey: `${kind}:${entryId}:${this.clock.now().getTime()}`,
    });
  }

  private async notifyOrganisers(
    tx: Tx,
    t: Tournament,
    actorId: string,
    title: string,
    kind: string,
    entryId: string,
  ) {
    await this.notifier.notify(tx, {
      recipientIds: await this.access.holders(tx, t, ['tournament.applications']),
      category: 'tournament',
      activityKind: kind,
      title,
      objectType: 'ClubEntry',
      objectId: entryId,
      actorId,
      essential: true,
      payload: { tournamentId: t.id, entryId },
      dedupeKey: `${kind}:${entryId}:${this.clock.now().getTime()}`,
    });
  }

  private assertOpenForEntries(t: Tournament): void {
    if (t.status === 'DRAFT') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    if (t.status !== 'REGISTRATION_OPEN') {
      throw new ApiError(ErrorCode.EXPIRED, 'Registration is not open', {
        reason: 'REGISTRATION_CLOSED',
        status: t.status,
      });
    }
  }

  private assertDecidable(t: Tournament): void {
    if (!['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'POSTPONED'].includes(t.status)) {
      throw new ApiError(ErrorCode.CONFLICT, 'Clubs can no longer be decided at this stage', {
        status: t.status,
      });
    }
  }

  // ───────────── club side ─────────────

  /** "Enter with my club": only for a club the caller may act for. Idempotent. */
  async enter(
    actorId: string,
    tournamentId: string,
    dto: EnterTournamentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<EntryDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.enter:${tournamentId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.assertOpenForEntries(t);
        const club = await tx.club.findUnique({ where: { id: dto.clubId } });
        if (!club || club.status !== 'ACTIVE')
          throw new ApiError(ErrorCode.NOT_FOUND, 'Club not found');
        await this.assertRep(tx, actorId, dto.clubId);
        if (await this.visibility.isBlockedEitherWay(actorId, t.organiserId, tx)) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, DENIED);
        }
        const existing = await tx.clubEntry.findUnique({
          where: { tournamentId_clubId: { tournamentId, clubId: dto.clubId } },
          include: ENTRY_INCLUDE,
        });
        let entry: EntryRow;
        if (!existing) {
          entry = await tx.clubEntry.create({
            data: { tournamentId, clubId: dto.clubId, status: 'APPLIED', submittedById: actorId },
            include: ENTRY_INCLUDE,
          });
          await this.notifyOrganisers(
            tx,
            t,
            actorId,
            'A club applied to your tournament',
            'tournament.entry_applied',
            entry.id,
          );
        } else if (['APPLIED', 'ACCEPTED', 'WAITLISTED'].includes(existing.status)) {
          entry = existing;
        } else if (existing.status === 'INVITED') {
          entry = await this.acceptInvited(tx, t, existing, actorId);
        } else if (existing.status === 'REJECTED') {
          throw new ApiError(ErrorCode.CONFLICT, 'The organiser declined this club', {
            status: existing.status,
          });
        } else {
          entry = await tx.clubEntry.update({
            where: { id: existing.id },
            data: { status: 'APPLIED', submittedById: actorId, decidedById: null, decidedAt: null },
            include: ENTRY_INCLUDE,
          });
          await this.notifyOrganisers(
            tx,
            t,
            actorId,
            'A club applied to your tournament',
            'tournament.entry_applied',
            entry.id,
          );
        }
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.entry.apply',
          targetType: 'ClubEntry',
          targetId: entry.id,
          requestId,
          metadata: { tournamentId, clubId: dto.clubId },
        });
        return this.one(tx, actorId, t, entry.id);
      },
    );
  }

  /** The invited club's representative says yes: the held spot becomes an accepted place. */
  private async acceptInvited(
    tx: Tx,
    t: Tournament,
    e: EntryRow,
    actorId: string,
  ): Promise<EntryRow> {
    const updated = await tx.clubEntry.update({
      where: { id: e.id },
      data: { status: 'ACCEPTED', submittedById: actorId, decidedAt: this.clock.now() },
      include: ENTRY_INCLUDE,
    });
    await this.ensureFees(tx, t, updated);
    await this.notifyOrganisers(
      tx,
      t,
      actorId,
      'An invited club accepted',
      'tournament.invitation_accepted',
      e.id,
    );
    return updated;
  }

  async respond(
    actorId: string,
    tournamentId: string,
    entryId: string,
    dto: RespondInvitationDto,
    key: string | undefined,
  ): Promise<EntryDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.respond:${entryId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        const e = await this.loadEntry(tx, tournamentId, entryId);
        await this.assertRep(tx, actorId, e.clubId);
        if (dto.accept) {
          if (e.status === 'ACCEPTED') return this.one(tx, actorId, t, e.id);
          if (e.status !== 'INVITED')
            throw new ApiError(ErrorCode.CONFLICT, 'There is no open invitation', {
              status: e.status,
            });
          this.assertDecidable(t);
          await this.acceptInvited(tx, t, e, actorId);
        } else {
          if (e.status === 'DECLINED') return this.one(tx, actorId, t, e.id);
          if (e.status !== 'INVITED')
            throw new ApiError(ErrorCode.CONFLICT, 'There is no open invitation', {
              status: e.status,
            });
          await tx.clubEntry.update({
            where: { id: e.id },
            data: { status: 'DECLINED', decidedAt: this.clock.now() },
          });
          await this.notifyOrganisers(
            tx,
            t,
            actorId,
            'An invited club declined',
            'tournament.invitation_declined',
            e.id,
          );
        }
        return this.one(tx, actorId, t, e.id);
      },
    );
  }

  async withdraw(
    actorId: string,
    tournamentId: string,
    entryId: string,
    key: string | undefined,
    requestId?: string,
  ): Promise<EntryDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.withdraw:${entryId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        const e = await this.loadEntry(tx, tournamentId, entryId);
        await this.assertRep(tx, actorId, e.clubId);
        if (e.status === 'WITHDRAWN') return this.one(tx, actorId, t, e.id);
        if (!['APPLIED', 'ACCEPTED', 'WAITLISTED', 'INVITED'].includes(e.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'This entry cannot be withdrawn', {
            status: e.status,
          });
        }
        if (t.status === 'LIVE' || TERMINAL.includes(t.status)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'After the start the organiser decides; contact them',
            {
              reason: 'ENTRY_LOCKED',
            },
          );
        }
        await tx.clubEntry.update({
          where: { id: e.id },
          data: { status: 'WITHDRAWN', decidedAt: this.clock.now() },
        });
        await this.releaseEntry(tx, e, actorId, 'Club withdrew from the tournament');
        await this.notifyOrganisers(
          tx,
          t,
          actorId,
          'A club withdrew',
          'tournament.entry_withdrawn',
          e.id,
        );
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.entry.withdraw',
          targetType: 'ClubEntry',
          targetId: e.id,
          requestId,
          metadata: { tournamentId, from: e.status },
        });
        return this.one(tx, actorId, t, e.id);
      },
    );
  }

  // ───────────── organiser side ─────────────

  async list(actorId: string, tournamentId: string, q: EntryListQuery): Promise<EntryPageDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    await this.access.assertCan(this.prisma, actorId, 'tournament.applications', t);
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.clubEntry.findMany({
      where: {
        tournamentId,
        ...(q.status ? { status: q.status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      include: ENTRY_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: await this.toDto(this.prisma, t, page.items, () => true),
      nextCursor: page.nextCursor,
    };
  }

  /** Entries of the clubs I can act for. */
  async mine(actorId: string, tournamentId: string): Promise<EntryDto[]> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    const clubs = await this.access.clubsFor(this.prisma, actorId, [
      'club.tournaments.enter',
      'club.squad.manage',
    ]);
    const rows = await this.prisma.clubEntry.findMany({
      where: { tournamentId, clubId: { in: clubs } },
      include: ENTRY_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return this.toDto(this.prisma, t, rows, () => true);
  }

  async get(actorId: string, tournamentId: string, entryId: string): Promise<EntryDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    const e = await this.loadEntry(this.prisma, tournamentId, entryId);
    if (
      !(await this.access.can(this.prisma, actorId, 'tournament.applications', t)) &&
      !(await this.mayActForClub(this.prisma, actorId, e.clubId))
    ) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return this.one(this.prisma, actorId, t, entryId);
  }

  async decide(
    actorId: string,
    tournamentId: string,
    entryId: string,
    dto: DecideEntryDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<EntryDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.decide:${entryId}`, key, payload: dto },
      async (tx) => {
        // Row lock on the tournament: the last spot goes to exactly one club.
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.access.assertCan(tx, actorId, 'tournament.applications', t);
        const e = await this.loadEntry(tx, tournamentId, entryId);
        const now = this.clock.now();

        if (dto.decision === 'ACCEPT') {
          if (e.status === 'ACCEPTED') return this.one(tx, actorId, t, e.id);
          if (!['APPLIED', 'WAITLISTED'].includes(e.status)) {
            throw new ApiError(ErrorCode.CONFLICT, 'This entry cannot be accepted', {
              status: e.status,
            });
          }
          this.assertDecidable(t);
          const taken = await this.takenSpots(tx, tournamentId, e.id);
          const full = t.maxClubs !== null && taken >= t.maxClubs;
          if (full) {
            if (e.status === 'APPLIED' && t.waitlistOpen) {
              await tx.clubEntry.update({
                where: { id: e.id },
                data: { status: 'WAITLISTED', decidedById: actorId, decidedAt: now },
              });
              await this.notifyClub(
                tx,
                t,
                e.clubId,
                actorId,
                'Your club is on the waiting list',
                'tournament.entry_waitlisted',
                e.id,
              );
              return this.one(tx, actorId, t, e.id);
            }
            throw new ApiError(
              ErrorCode.CAPACITY_CHANGED,
              'No free places left in this tournament',
              {
                maxClubs: t.maxClubs,
              },
            );
          }
          const accepted = await tx.clubEntry.update({
            where: { id: e.id },
            data: { status: 'ACCEPTED', decidedById: actorId, decidedAt: now },
            include: ENTRY_INCLUDE,
          });
          await this.ensureFees(tx, t, accepted);
          await this.notifyClub(
            tx,
            t,
            e.clubId,
            actorId,
            'Your club was accepted',
            'tournament.entry_accepted',
            e.id,
          );
        } else {
          if (e.status === 'REJECTED') return this.one(tx, actorId, t, e.id);
          if (!['APPLIED', 'WAITLISTED', 'INVITED', 'ACCEPTED'].includes(e.status)) {
            throw new ApiError(ErrorCode.CONFLICT, 'This entry cannot be rejected', {
              status: e.status,
            });
          }
          this.assertDecidable(t);
          await tx.clubEntry.update({
            where: { id: e.id },
            data: { status: 'REJECTED', decidedById: actorId, decidedAt: now },
          });
          await this.releaseEntry(tx, e, actorId, dto.reason ?? 'Club removed from the tournament');
          await this.notifyClub(
            tx,
            t,
            e.clubId,
            actorId,
            'Your club entry was declined',
            'tournament.entry_rejected',
            e.id,
          );
        }
        await this.audit.record(tx, {
          actorId,
          action: `tournament.entry.${dto.decision.toLowerCase()}`,
          targetType: 'ClubEntry',
          targetId: e.id,
          requestId,
          metadata: { tournamentId, from: e.status, reason: dto.reason },
        });
        return this.one(tx, actorId, t, e.id);
      },
    );
  }

  /** Targeted invitation: holds a spot (INVITED); coexists with open applications. */
  async inviteClub(
    actorId: string,
    tournamentId: string,
    dto: InviteClubDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<EntryDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.inviteClub:${tournamentId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.access.assertCan(tx, actorId, 'tournament.applications', t);
        this.assertOpenForEntries(t);
        const club = await tx.club.findUnique({ where: { id: dto.clubId } });
        if (!club || club.status !== 'ACTIVE')
          throw new ApiError(ErrorCode.NOT_FOUND, 'Club not found');
        const existing = await tx.clubEntry.findUnique({
          where: { tournamentId_clubId: { tournamentId, clubId: dto.clubId } },
          include: ENTRY_INCLUDE,
        });
        if (existing?.status === 'INVITED') return this.one(tx, actorId, t, existing.id);
        if (existing && ['APPLIED', 'ACCEPTED', 'WAITLISTED'].includes(existing.status)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'This club already has an entry; decide it instead',
            {
              status: existing.status,
            },
          );
        }
        const taken = await this.takenSpots(tx, tournamentId);
        if (t.maxClubs !== null && taken >= t.maxClubs) {
          throw new ApiError(
            ErrorCode.CAPACITY_CHANGED,
            'No free places to hold for an invitation',
          );
        }
        const entry = existing
          ? await tx.clubEntry.update({
              where: { id: existing.id },
              data: {
                status: 'INVITED',
                submittedById: actorId,
                decidedById: null,
                decidedAt: null,
              },
              include: ENTRY_INCLUDE,
            })
          : await tx.clubEntry.create({
              data: { tournamentId, clubId: dto.clubId, status: 'INVITED', submittedById: actorId },
              include: ENTRY_INCLUDE,
            });
        await this.notifyClub(
          tx,
          t,
          dto.clubId,
          actorId,
          'Your club was invited to a tournament',
          'tournament.club_invited',
          entry.id,
        );
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.entry.invite',
          targetType: 'ClubEntry',
          targetId: entry.id,
          requestId,
          metadata: { tournamentId, clubId: dto.clubId },
        });
        return this.one(tx, actorId, t, entry.id);
      },
    );
  }

  // ───────────── squad ─────────────

  private async playerDto(
    db: Db,
    t: Tournament,
    e: EntryRow,
    rows: ClubEntryPlayer[],
  ): Promise<SquadPlayerDto[]> {
    const rd = (await this.readiness.forEntries(db, t, [{ ...e, players: rows }])).get(
      e.id,
    ) as EntryReadiness;
    const people = await loadPersonSummaries(
      db,
      rows.map((p) => p.userId),
    );
    const profiles = await db.profile.findMany({
      where: { userId: { in: rows.map((p) => p.userId) } },
      select: { userId: true, dateOfBirth: true },
    });
    const dob = new Map(profiles.map((p) => [p.userId, p.dateOfBirth]));
    return rows.map((p) => {
      const pr = rd.players.get(p.userId);
      return {
        person: personOrUnknown(people, p.userId),
        status: p.status,
        isGuest: p.isGuest,
        ageEligibility: pr?.eligibility ?? tournamentAgeEligibility(dob.get(p.userId) ?? null, t),
        ageExceptionApproved: p.ageExceptionApprovedById !== null,
        missingDocumentIds: pr?.missingDocumentIds ?? [],
        invitedAt: p.createdAt.toISOString(),
      };
    });
  }

  async squad(actorId: string, tournamentId: string, entryId: string): Promise<SquadDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    const e = await this.loadEntry(this.prisma, tournamentId, entryId);
    if (
      !(await this.mayActForClub(this.prisma, actorId, e.clubId)) &&
      !(await this.access.can(this.prisma, actorId, 'tournament.applications', t))
    ) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const active = e.players
      .filter((p) => ['INVITED', 'CONFIRMED'].includes(p.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      entry: await this.one(this.prisma, actorId, t, entryId),
      players: await this.playerDto(this.prisma, t, e, active),
    };
  }

  async invitePlayers(
    actorId: string,
    tournamentId: string,
    entryId: string,
    dto: InvitePlayersDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<InvitePlayersResultDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.invitePlayers:${entryId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertNotTerminal(t);
        const e = await this.loadEntry(tx, tournamentId, entryId);
        await this.assertSquadManager(tx, actorId, e.clubId);
        if (!['APPLIED', 'ACCEPTED', 'WAITLISTED'].includes(e.status)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The squad can only be built for an applied or accepted club',
            {
              status: e.status,
            },
          );
        }
        const isGuest = dto.isGuest ?? false;
        const skipped: InvitePlayersResultDto['skipped'] = [];
        const toInvite: { userId: string; needsException: boolean; existingId: string | null }[] =
          [];
        for (const userId of dto.userIds) {
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: { status: true, privacy: true, profile: { select: { dateOfBirth: true } } },
          });
          if (user?.status !== 'ACTIVE' || !user.privacy) {
            skipped.push({ userId, reason: 'NOT_FOUND' });
            continue;
          }
          if (userId !== actorId) {
            const rel = await this.visibility.relationship(actorId, userId, tx);
            const member = await tx.membership.findUnique({
              where: { clubId_userId: { clubId: e.clubId, userId } },
            });
            if (
              rel.blocked ||
              !this.visibility.canInvite(user.privacy, rel, member?.status === 'MEMBER')
            ) {
              skipped.push({ userId, reason: 'NOT_ALLOWED' });
              continue;
            }
          }
          const member = await tx.membership.findUnique({
            where: { clubId_userId: { clubId: e.clubId, userId } },
          });
          if (!isGuest && member?.status !== 'MEMBER') {
            skipped.push({ userId, reason: 'NOT_A_MEMBER' });
            continue;
          }
          const elig = tournamentAgeEligibility(user.profile?.dateOfBirth ?? null, t);
          if (elig === 'NOT_ALLOWED') {
            skipped.push({ userId, reason: 'AGE_NOT_ALLOWED' });
            continue;
          }
          if (elig === 'UNKNOWN_DOB') {
            skipped.push({ userId, reason: 'DOB_REQUIRED' });
            continue;
          }
          const row = await tx.clubEntryPlayer.findUnique({
            where: { tournamentId_userId: { tournamentId, userId } },
          });
          if (row && ['INVITED', 'CONFIRMED'].includes(row.status)) {
            skipped.push({
              userId,
              reason: row.entryId === entryId ? 'ALREADY_IN_SQUAD' : 'ALREADY_IN_OTHER_SQUAD',
            });
            continue;
          }
          toInvite.push({
            userId,
            needsException: elig === 'EXCEPTION_REQUIRED',
            existingId: row?.id ?? null,
          });
        }
        if (toInvite.length === 0 && skipped.some((s) => s.reason === 'ALREADY_IN_OTHER_SQUAD')) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'A person can be in only one squad per tournament',
            {
              skipped,
            },
          );
        }
        if (t.maxPlayersPerClub !== null) {
          const active = e.players.filter((p) =>
            ['INVITED', 'CONFIRMED'].includes(p.status),
          ).length;
          if (active + toInvite.length > t.maxPlayersPerClub) {
            throw new ApiError(ErrorCode.CAPACITY_CHANGED, 'The squad would exceed the maximum', {
              max: t.maxPlayersPerClub,
              active,
            });
          }
        }
        const created: ClubEntryPlayer[] = [];
        try {
          for (const i of toInvite) {
            const data = {
              entryId,
              tournamentId,
              userId: i.userId,
              status: 'INVITED' as const,
              isGuest,
              ageExceptionApprovedById: null,
            };
            created.push(
              i.existingId
                ? await tx.clubEntryPlayer.update({ where: { id: i.existingId }, data })
                : await tx.clubEntryPlayer.create({ data }),
            );
          }
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'A person can be in only one squad per tournament',
            );
          }
          throw err;
        }
        await this.notifier.notify(tx, {
          recipientIds: created.map((c) => c.userId),
          category: 'tournament',
          activityKind: 'tournament.squad_invited',
          title: 'You were invited to a tournament squad',
          objectType: 'ClubEntry',
          objectId: entryId,
          actorId,
          payload: { tournamentId, entryId },
        });
        const exceptions = toInvite.filter((i) => i.needsException);
        if (exceptions.length > 0) {
          await this.notifier.notify(tx, {
            recipientIds: [t.organiserId],
            category: 'tournament',
            activityKind: 'tournament.age_exception_needed',
            title: 'A younger player needs your age exception decision',
            objectType: 'ClubEntry',
            objectId: entryId,
            actorId,
            essential: true,
            payload: { tournamentId, entryId },
            dedupeKey: `age-exc:${entryId}:${exceptions.map((x) => x.userId).join(',')}`,
          });
        }
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.squad.invite',
          targetType: 'ClubEntry',
          targetId: entryId,
          requestId,
          metadata: { count: created.length, isGuest },
        });
        const fresh = await this.loadEntry(tx, tournamentId, entryId);
        return {
          invited: await this.playerDto(tx, t, fresh, created),
          skipped,
        };
      },
    );
  }

  async removePlayer(
    actorId: string,
    tournamentId: string,
    entryId: string,
    userId: string,
    key: string | undefined,
  ): Promise<SquadDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.removePlayer:${entryId}:${userId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertNotTerminal(t);
        const e = await this.loadEntry(tx, tournamentId, entryId);
        await this.assertSquadManager(tx, actorId, e.clubId);
        const row = e.players.find((p) => p.userId === userId);
        if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (['INVITED', 'CONFIRMED'].includes(row.status)) {
          await tx.clubEntryPlayer.update({ where: { id: row.id }, data: { status: 'REMOVED' } });
          await settleObligations(
            tx,
            { tournamentId, kind: 'TOURNAMENT_PLAYER_FEE', payerUserId: userId },
            actorId,
            'Removed from the squad',
          );
          await this.notifier.notify(tx, {
            recipientIds: [userId],
            category: 'tournament',
            activityKind: 'tournament.squad_removed',
            title: 'You were removed from a tournament squad',
            objectType: 'ClubEntry',
            objectId: entryId,
            actorId,
            essential: true,
            dedupeKey: `squad-removed:${row.id}:${this.clock.now().getTime()}`,
          });
        }
        return this.squadFrom(tx, actorId, t, entryId);
      },
    );
  }

  private async squadFrom(
    tx: Tx,
    actorId: string,
    t: Tournament,
    entryId: string,
  ): Promise<SquadDto> {
    const e = await this.loadEntry(tx, t.id, entryId);
    const active = e.players.filter((p) => ['INVITED', 'CONFIRMED'].includes(p.status));
    return {
      entry: await this.one(tx, actorId, t, entryId),
      players: await this.playerDto(tx, t, e, active),
    };
  }

  /** Chief organiser decides an age exception individually (invitations never bypass age). */
  async decideAgeException(
    actorId: string,
    tournamentId: string,
    entryId: string,
    userId: string,
    dto: AgeExceptionDecisionDto,
    requestId?: string,
  ): Promise<SquadDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockTournament(tx, tournamentId);
      const t = await this.access.loadVisible(tx, actorId, tournamentId);
      this.access.assertOrganiser(actorId, t);
      this.access.assertNotTerminal(t);
      const e = await this.loadEntry(tx, tournamentId, entryId);
      const row = e.players.find(
        (p) => p.userId === userId && ['INVITED', 'CONFIRMED'].includes(p.status),
      );
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { dateOfBirth: true },
      });
      if (tournamentAgeEligibility(profile?.dateOfBirth ?? null, t) !== 'EXCEPTION_REQUIRED') {
        throw new ApiError(ErrorCode.CONFLICT, 'No age exception is needed for this player');
      }
      if (dto.approve) {
        await tx.clubEntryPlayer.update({
          where: { id: row.id },
          data: { ageExceptionApprovedById: actorId },
        });
      } else {
        await tx.clubEntryPlayer.update({
          where: { id: row.id },
          data: { status: 'REMOVED', ageExceptionApprovedById: null },
        });
        await settleObligations(
          tx,
          { tournamentId, kind: 'TOURNAMENT_PLAYER_FEE', payerUserId: userId },
          actorId,
          'Age exception refused',
        );
      }
      await this.notifier.notify(tx, {
        recipientIds: [userId, e.submittedById],
        category: 'tournament',
        activityKind: 'tournament.age_exception_decided',
        title: dto.approve ? 'Age exception approved' : 'Age exception refused',
        objectType: 'ClubEntry',
        objectId: entryId,
        actorId,
        essential: true,
        dedupeKey: `age-exc-decision:${row.id}:${dto.approve}:${this.clock.now().getTime()}`,
      });
      await this.audit.record(tx, {
        actorId,
        action: dto.approve
          ? 'tournament.age_exception.approve'
          : 'tournament.age_exception.refuse',
        targetType: 'ClubEntryPlayer',
        targetId: row.id,
        requestId,
        metadata: { tournamentId, entryId, reason: dto.reason, scope: 'TOURNAMENT' },
      });
      return this.squadFrom(tx, actorId, t, entryId);
    });
  }

  // ───────────── player side ─────────────

  async me(userId: string, tournamentId: string): Promise<MyPlayerDto> {
    const t = await this.access.loadVisible(this.prisma, userId, tournamentId);
    const row = await this.prisma.clubEntryPlayer.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const e = await this.loadEntry(this.prisma, tournamentId, row.entryId);
    const [p] = await this.playerDto(this.prisma, t, e, [row]);
    const player = p as SquadPlayerDto;
    return {
      tournamentId,
      entryId: e.id,
      club: e.club,
      status: row.status,
      isGuest: row.isGuest,
      ageEligibility: player.ageEligibility,
      ageExceptionApproved: player.ageExceptionApproved,
      missingDocumentIds: player.missingDocumentIds,
      canConfirm:
        row.status === 'INVITED' &&
        (player.ageEligibility === 'ELIGIBLE' ||
          (player.ageEligibility === 'EXCEPTION_REQUIRED' && player.ageExceptionApproved)),
    };
  }

  async confirm(
    userId: string,
    tournamentId: string,
    key: string | undefined,
  ): Promise<MyPlayerDto> {
    return this.idempotency.execute(
      { userId, scope: `tournaments.playerConfirm:${tournamentId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, userId, tournamentId);
        this.access.assertNotTerminal(t);
        const row = await tx.clubEntryPlayer.findUnique({
          where: { tournamentId_userId: { tournamentId, userId } },
        });
        if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (row.status === 'CONFIRMED') return this.meTx(tx, userId, tournamentId);
        if (row.status !== 'INVITED') {
          throw new ApiError(ErrorCode.CONFLICT, 'There is no open squad invitation', {
            status: row.status,
          });
        }
        const e = await this.loadEntry(tx, tournamentId, row.entryId);
        if (!(ACTIVE_ENTRY as readonly string[]).includes(e.status) || e.status === 'INVITED') {
          throw new ApiError(ErrorCode.CONFLICT, 'This club entry is not active', {
            status: e.status,
          });
        }
        const profile = await tx.profile.findUnique({
          where: { userId },
          select: { dateOfBirth: true },
        });
        const elig = tournamentAgeEligibility(profile?.dateOfBirth ?? null, t);
        if (elig === 'NOT_ALLOWED') {
          throw new ApiError(
            ErrorCode.ACCESS_DENIED,
            'This tournament is not open to your age group',
            { reason: 'AGE' },
          );
        }
        if (elig === 'UNKNOWN_DOB') {
          throw new ApiError(ErrorCode.VALIDATION, 'Date of birth is required', {
            reason: 'DOB_REQUIRED',
          });
        }
        if (elig === 'EXCEPTION_REQUIRED' && !row.ageExceptionApprovedById) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The organiser must approve your age exception first',
            {
              reason: 'AGE_EXCEPTION_PENDING',
            },
          );
        }
        await tx.clubEntryPlayer.update({ where: { id: row.id }, data: { status: 'CONFIRMED' } });
        if (t.feeMode === 'PER_PLAYER' && e.status === 'ACCEPTED') {
          await this.payments.ensureTournamentObligation(tx, {
            kind: 'TOURNAMENT_PLAYER_FEE',
            tournamentId,
            payerUserId: userId,
            amountMinor: t.feeMinor,
            currency: t.currency,
          });
        }
        await this.notifier.notify(tx, {
          recipientIds: [e.submittedById],
          category: 'tournament',
          activityKind: 'tournament.player_confirmed',
          title: 'A player confirmed for your squad',
          objectType: 'ClubEntry',
          objectId: e.id,
          actorId: userId,
          essential: true,
          dedupeKey: `player-confirmed:${row.id}`,
        });
        return this.meTx(tx, userId, tournamentId);
      },
    );
  }

  private async meTx(tx: Tx, userId: string, tournamentId: string): Promise<MyPlayerDto> {
    const row = await tx.clubEntryPlayer.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    const t = await this.access.loadVisible(tx, userId, tournamentId);
    const e = await this.loadEntry(tx, tournamentId, row.entryId);
    const [p] = await this.playerDto(tx, t, e, [row]);
    const player = p as SquadPlayerDto;
    return {
      tournamentId,
      entryId: e.id,
      club: e.club,
      status: row.status,
      isGuest: row.isGuest,
      ageEligibility: player.ageEligibility,
      ageExceptionApproved: player.ageExceptionApproved,
      missingDocumentIds: player.missingDocumentIds,
      canConfirm:
        row.status === 'INVITED' &&
        (player.ageEligibility === 'ELIGIBLE' || player.ageExceptionApproved),
    };
  }

  async decline(
    userId: string,
    tournamentId: string,
    key: string | undefined,
  ): Promise<MyPlayerDto> {
    return this.idempotency.execute(
      { userId, scope: `tournaments.playerDecline:${tournamentId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, userId, tournamentId);
        const row = await tx.clubEntryPlayer.findUnique({
          where: { tournamentId_userId: { tournamentId, userId } },
        });
        if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (row.status === 'DECLINED') return this.meTx(tx, userId, tournamentId);
        if (!['INVITED', 'CONFIRMED'].includes(row.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'Nothing to decline', { status: row.status });
        }
        if (t.status === 'LIVE') {
          throw new ApiError(ErrorCode.CONFLICT, 'After the start ask your club representative', {
            reason: 'SQUAD_LOCKED',
          });
        }
        await tx.clubEntryPlayer.update({ where: { id: row.id }, data: { status: 'DECLINED' } });
        await settleObligations(
          tx,
          { tournamentId, kind: 'TOURNAMENT_PLAYER_FEE', payerUserId: userId },
          userId,
          'Player declined',
        );
        const e = await this.loadEntry(tx, tournamentId, row.entryId);
        await this.notifier.notify(tx, {
          recipientIds: [e.submittedById],
          category: 'tournament',
          activityKind: 'tournament.player_declined',
          title: 'A player declined your squad invitation',
          objectType: 'ClubEntry',
          objectId: e.id,
          actorId: userId,
          essential: true,
          dedupeKey: `player-declined:${row.id}:${this.clock.now().getTime()}`,
        });
        return this.meTx(tx, userId, tournamentId);
      },
    );
  }
}
