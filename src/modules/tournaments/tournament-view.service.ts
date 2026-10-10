import { Injectable } from '@nestjs/common';
import type { Sponsor, Tournament } from '@prisma/client';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import { DocumentsService } from './documents.service';
import {
  TournamentCapabilitiesDto,
  TournamentCardDto,
  TournamentDto,
  TournamentViewerDto,
  type ManagerCountersDto,
  type TournamentLabel,
} from './dto/tournament.dto';
import { ReadinessService } from './readiness.service';
import { ACTIVE_ENTRY, TERMINAL, TournamentAccess } from './tournament-access.service';
import { isoDate } from './tournament-support';

export interface EntryCounts {
  accepted: number;
  invited: number;
  applied: number;
  waitlisted: number;
}

const STARTS_SOON_DAYS = 7;

@Injectable()
export class TournamentViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly documents: DocumentsService,
    private readonly readiness: ReadinessService,
    private readonly clock: Clock,
  ) {}

  async counts(db: Db, ids: string[]): Promise<Map<string, EntryCounts>> {
    const out = new Map<string, EntryCounts>(
      ids.map((id) => [id, { accepted: 0, invited: 0, applied: 0, waitlisted: 0 }]),
    );
    if (ids.length === 0) return out;
    const rows = await db.clubEntry.groupBy({
      by: ['tournamentId', 'status'],
      where: { tournamentId: { in: ids }, status: { in: [...ACTIVE_ENTRY] } },
      _count: { _all: true },
    });
    for (const r of rows) {
      const c = out.get(r.tournamentId);
      if (!c) continue;
      const n = r._count._all;
      if (r.status === 'ACCEPTED') c.accepted = n;
      else if (r.status === 'INVITED') c.invited = n;
      else if (r.status === 'APPLIED') c.applied = n;
      else if (r.status === 'WAITLISTED') c.waitlisted = n;
    }
    return out;
  }

  label(t: Tournament, c: EntryCounts): TournamentLabel {
    switch (t.status) {
      case 'DRAFT':
        return 'DRAFT';
      case 'REGISTRATION_OPEN':
        return t.maxClubs !== null && c.accepted + c.invited >= t.maxClubs && t.waitlistOpen
          ? 'WAITLIST_OPEN'
          : 'REGISTRATION_OPEN';
      case 'REGISTRATION_CLOSED': {
        const days = (t.startsOn.getTime() - this.clock.now().getTime()) / 86_400_000;
        return days >= -1 && days <= STARTS_SOON_DAYS ? 'STARTS_SOON' : 'REGISTRATION_CLOSED';
      }
      default:
        return t.status;
    }
  }

  private async mainSponsors(db: Db, ts: Tournament[]): Promise<Map<string, Sponsor>> {
    const ids = ts.flatMap((t) => (t.mainSponsorId ? [t.mainSponsorId] : []));
    if (ids.length === 0) return new Map();
    const rows = await db.sponsor.findMany({ where: { id: { in: ids }, hiddenAt: null } });
    return new Map(rows.map((s) => [s.tournamentId, s]));
  }

  async cards(db: Db, ts: Tournament[]): Promise<TournamentCardDto[]> {
    const [counts, sponsors] = await Promise.all([
      this.counts(
        db,
        ts.map((t) => t.id),
      ),
      this.mainSponsors(db, ts),
    ]);
    return ts.map((t) => this.card(t, counts.get(t.id) as EntryCounts, sponsors.get(t.id) ?? null));
  }

  card(t: Tournament, c: EntryCounts, sponsor: Sponsor | null): TournamentCardDto {
    return {
      id: t.id,
      name: t.name,
      logoMediaId: t.logoMediaId,
      city: t.city,
      timezone: t.timezone,
      duration: t.duration,
      startsOn: isoDate(t.startsOn),
      endsOn: t.endsOn ? isoDate(t.endsOn) : null,
      formatPlayers: t.formatPlayers,
      ageBand: t.ageBand,
      feeMode: t.feeMode,
      feeMinor: t.feeMinor,
      currency: t.currency,
      status: t.status,
      label: this.label(t, c),
      acceptedClubs: c.accepted,
      maxClubs: t.maxClubs,
      openSpots: t.maxClubs === null ? null : Math.max(0, t.maxClubs - c.accepted - c.invited),
      isPublic: t.isPublic,
      mainSponsor: sponsor
        ? {
            id: sponsor.id,
            name: sponsor.name,
            logoMediaId: sponsor.logoMediaId,
            externalUrl: sponsor.externalUrl,
          }
        : null,
    };
  }

  /** Viewer-aware page. NOT_FOUND unless the viewer may see the tournament. */
  async detail(db: Db, viewerId: string | null, id: string): Promise<TournamentDto> {
    const t = await this.access.loadVisible(db, viewerId, id);
    const [cards, organiserMap, scheduleVersion] = await Promise.all([
      this.cards(db, [t]),
      loadPersonSummaries(db, [t.organiserId]),
      db.fixture.aggregate({ where: { tournamentId: t.id }, _max: { scheduleVersion: true } }),
    ]);
    const card = cards[0] as TournamentCardDto;
    const viewer = viewerId ? await this.viewerState(db, viewerId, t) : null;
    const caps = await this.capabilities(db, viewerId, t, viewer);
    const manager = viewerId
      ? await this.access.can(db, viewerId, 'tournament.applications', t)
      : false;
    return {
      ...card,
      description: t.description,
      organiser: personOrUnknown(organiserMap, t.organiserId),
      minClubs: t.minClubs,
      minPlayersPerClub: t.minPlayersPerClub,
      maxPlayersPerClub: t.maxPlayersPerClub,
      allowYounger: t.allowYounger,
      waitlistOpen: t.waitlistOpen,
      publishedAt: t.publishedAt?.toISOString() ?? null,
      version: t.version,
      scheduleVersion: scheduleVersion._max.scheduleVersion ?? 0,
      counters: manager ? await this.managerCounters(db, t) : null,
      viewer,
      capabilities: caps,
    };
  }

  private async managerCounters(db: Db, t: Tournament): Promise<ManagerCountersDto> {
    const [counts, accepted] = await Promise.all([
      this.counts(db, [t.id]),
      db.clubEntry.findMany({
        where: { tournamentId: t.id, status: 'ACCEPTED' },
        include: { players: true },
      }),
    ]);
    const r = await this.readiness.forEntries(db, t, accepted);
    const c = counts.get(t.id) as EntryCounts;
    return {
      applications: c.applied,
      invited: c.invited,
      waitlisted: c.waitlisted,
      readyClubs: [...r.values()].filter((x) => x.ready).length,
    };
  }

  private async viewerState(db: Db, userId: string, t: Tournament): Promise<TournamentViewerDto> {
    const actClubs = await this.access.clubsFor(db, userId, [
      'club.tournaments.enter',
      'club.squad.manage',
    ]);
    const enterClubs = await this.access.clubsFor(db, userId, ['club.tournaments.enter']);
    const clubIds = [...new Set([...actClubs, ...enterClubs])];
    const [entries, clubs, player, required] = await Promise.all([
      db.clubEntry.findMany({
        where: { tournamentId: t.id, clubId: { in: clubIds } },
        include: { club: { select: { name: true } } },
      }),
      db.club.findMany({ where: { id: { in: enterClubs } }, select: { id: true, name: true } }),
      db.clubEntryPlayer.findFirst({
        where: { tournamentId: t.id, userId },
        include: { entry: { select: { clubId: true } } },
      }),
      this.documents.requiredFor(db, userId, t),
    ]);
    const byClub = new Map(entries.map((e) => [e.clubId, e]));
    const obligations = await db.paymentObligation.findMany({
      where: {
        tournamentId: t.id,
        OR: [{ payerUserId: userId }, { payerClubId: { in: clubIds } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      entries: entries.map((e) => ({
        entryId: e.id,
        clubId: e.clubId,
        clubName: e.club.name,
        status: e.status,
      })),
      enterableClubs: clubs.map((c) => ({
        clubId: c.id,
        clubName: c.name,
        entryStatus: byClub.get(c.id)?.status ?? null,
      })),
      player: player
        ? {
            entryId: player.entryId,
            clubId: player.entry.clubId,
            status: player.status,
            isGuest: player.isGuest,
          }
        : null,
      missingConsents: required.filter((d) => d.mandatory && !d.accepted).length,
      obligations: obligations.map((o) => ({
        id: o.id,
        kind: o.kind,
        status: o.status,
        amountMinor: o.amountMinor,
        paidMinor: o.paidMinor,
        currency: o.currency,
        payerClubId: o.payerClubId,
      })),
    };
  }

  /** Same calls the mutations use, so a capability never disagrees with enforcement. */
  private async capabilities(
    db: Db,
    viewerId: string | null,
    t: Tournament,
    viewer: TournamentViewerDto | null,
  ): Promise<TournamentCapabilitiesDto> {
    const none: TournamentCapabilitiesDto = {
      canEnter: false,
      canManage: false,
      canEdit: false,
      canPublish: false,
      canStart: false,
      canCancel: false,
      canAppointAssistants: false,
      canManageApplications: false,
      canSchedule: false,
      canRecordResults: false,
      canManageCash: false,
      canEditSponsors: false,
      canManageDocuments: false,
    };
    if (!viewerId) return none;
    const terminal = TERMINAL.includes(t.status);
    const organiser = this.access.isOrganiser(viewerId, t);
    const [apps, schedule, protocols, cash, sponsors] = await Promise.all([
      this.access.can(db, viewerId, 'tournament.applications', t),
      this.access.can(db, viewerId, 'tournament.schedule', t),
      this.access.can(db, viewerId, 'tournament.protocols', t),
      this.access.can(db, viewerId, 'tournament.cash', t),
      this.access.can(db, viewerId, 'tournament.sponsors', t),
    ]);
    const freeClub = (viewer?.enterableClubs ?? []).some(
      (c) => c.entryStatus === null || ['DECLINED', 'WITHDRAWN'].includes(c.entryStatus),
    );
    return {
      canEnter: t.status === 'REGISTRATION_OPEN' && !organiser && freeClub,
      canManage: organiser,
      canEdit: organiser && !terminal,
      canPublish: organiser && t.status === 'DRAFT',
      canStart: organiser && ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(t.status),
      canCancel: organiser && !terminal,
      canAppointAssistants: organiser && t.status !== 'DRAFT' && !terminal,
      canManageApplications: apps && !terminal,
      canSchedule: schedule && !terminal,
      canRecordResults: protocols && t.status === 'LIVE',
      canManageCash: cash,
      // sponsors stay editable in every stage, LIVE and FINISHED included
      canEditSponsors: organiser || sponsors,
      canManageDocuments: organiser && !terminal,
    };
  }
}
