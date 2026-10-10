import { Injectable } from '@nestjs/common';
import { Prisma, type Tournament, type TournamentStatus } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { clampPageSize, decodeCursor, encodeCursor } from '../../common/pagination/cursor-page';
import type { PermissionName } from '../../common/permissions/permissions';
import { Clock } from '../../common/time/clock';
import { localDateParts } from '../../common/time/local-time';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import {
  ASSISTANT_PERMISSIONS,
  type AppointAssistantDto,
  type AssistantsDto,
  type CancelTournamentDto,
  type CreateTournamentDto,
  type FinishTournamentDto,
  type PostponeTournamentDto,
  type ProblemDto,
  type RevokedDto,
  type TournamentDto,
  type TournamentListQuery,
  type TournamentPageDto,
  type UpdateTournamentDto,
} from './dto/tournament.dto';
import { analyseSchedule } from './logic/scheduler';
import { ReadinessService } from './readiness.service';
import {
  ACTIVE_ENTRY,
  TERMINAL,
  TournamentAccess,
  lockTournament,
} from './tournament-access.service';
import { StructureService } from './structure.service';
import {
  assertReadyMedia,
  assertTimezone,
  isoDate,
  parseDate,
  settleObligations,
} from './tournament-support';
import { TournamentViewService } from './tournament-view.service';
import { TournamentBookingsService } from './tournament-bookings.service';

interface Core {
  name: string;
  description: string | null;
  city: string;
  timezone: string;
  duration: Tournament['duration'];
  startsOn: string;
  endsOn: string | null;
  formatPlayers: number;
  ageBand: Tournament['ageBand'];
  allowYounger: boolean;
  feeMode: Tournament['feeMode'];
  feeMinor: number;
  currency: string;
  minClubs: number | null;
  maxClubs: number | null;
  minPlayersPerClub: number | null;
  maxPlayersPerClub: number | null;
  isPublic: boolean;
  waitlistOpen: boolean;
  logoMediaId: string | null;
}

const MATERIAL: (keyof Core)[] = [
  'formatPlayers',
  'ageBand',
  'allowYounger',
  'feeMode',
  'feeMinor',
  'currency',
];

function validateCore(c: Core): void {
  assertTimezone(c.timezone);
  parseDate(c.startsOn);
  if (c.endsOn) parseDate(c.endsOn);
  if (c.duration === 'ONE_DAY') {
    if (c.endsOn && c.endsOn !== c.startsOn) {
      throw new ApiError(ErrorCode.VALIDATION, 'A one-day tournament ends on its start date', {
        field: 'endsOn',
      });
    }
  } else if (!c.endsOn || c.endsOn < c.startsOn) {
    throw new ApiError(ErrorCode.VALIDATION, 'endsOn must be on or after startsOn', {
      field: 'endsOn',
    });
  }
  if (c.feeMode === 'FREE' && c.feeMinor !== 0) {
    throw new ApiError(ErrorCode.VALIDATION, 'A free tournament has no fee', { field: 'feeMinor' });
  }
  if (c.feeMode !== 'FREE' && c.feeMinor <= 0) {
    throw new ApiError(ErrorCode.VALIDATION, 'A fee amount is required', { field: 'feeMinor' });
  }
  if (c.minClubs !== null && c.maxClubs !== null && c.minClubs > c.maxClubs) {
    throw new ApiError(ErrorCode.VALIDATION, 'minClubs cannot exceed maxClubs', {
      field: 'minClubs',
    });
  }
  if (
    c.minPlayersPerClub !== null &&
    c.maxPlayersPerClub !== null &&
    c.minPlayersPerClub > c.maxPlayersPerClub
  ) {
    throw new ApiError(ErrorCode.VALIDATION, 'minPlayersPerClub cannot exceed maxPlayersPerClub', {
      field: 'minPlayersPerClub',
    });
  }
}

function coreOf(t: Tournament): Core {
  return {
    name: t.name,
    description: t.description,
    city: t.city,
    timezone: t.timezone,
    duration: t.duration,
    startsOn: isoDate(t.startsOn),
    endsOn: t.endsOn ? isoDate(t.endsOn) : null,
    formatPlayers: t.formatPlayers,
    ageBand: t.ageBand,
    allowYounger: t.allowYounger,
    feeMode: t.feeMode,
    feeMinor: t.feeMinor,
    currency: t.currency,
    minClubs: t.minClubs,
    maxClubs: t.maxClubs,
    minPlayersPerClub: t.minPlayersPerClub,
    maxPlayersPerClub: t.maxPlayersPerClub,
    isPublic: t.isPublic,
    waitlistOpen: t.waitlistOpen,
    logoMediaId: t.logoMediaId,
  };
}

const csv = (v?: string): string[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly view: TournamentViewService,
    private readonly readiness: ReadinessService,
    private readonly structure: StructureService,
    private readonly rentals: TournamentBookingsService,
    private readonly idempotency: IdempotencyService,
    private readonly accessGrants: AccessService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── create / edit ─────────────

  async create(
    actorId: string,
    dto: CreateTournamentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<TournamentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: 'tournaments.create', key, payload: dto },
      async (tx) => {
        const profile = await tx.profile.findUnique({
          where: { userId: actorId },
          select: { completedAt: true },
        });
        if (!profile?.completedAt) {
          throw new ApiError(ErrorCode.VALIDATION, 'Complete your profile before organising', {
            reason: 'PROFILE_INCOMPLETE',
          });
        }
        const ageBand = dto.ageBand ?? 'NONE';
        const core: Core = {
          name: dto.name.trim(),
          description: dto.description ?? null,
          city: dto.city.trim(),
          timezone: dto.timezone,
          duration: dto.duration,
          startsOn: dto.startsOn,
          endsOn: dto.endsOn ?? (dto.duration === 'ONE_DAY' ? dto.startsOn : null),
          formatPlayers: dto.formatPlayers,
          ageBand,
          allowYounger: ageBand === 'NONE' ? false : (dto.allowYounger ?? false),
          feeMode: dto.feeMode ?? 'FREE',
          feeMinor: dto.feeMinor ?? 0,
          currency: dto.currency ?? 'GEL',
          minClubs: dto.minClubs ?? null,
          maxClubs: dto.maxClubs ?? null,
          minPlayersPerClub: dto.minPlayersPerClub ?? null,
          maxPlayersPerClub: dto.maxPlayersPerClub ?? null,
          isPublic: dto.isPublic ?? true,
          waitlistOpen: dto.waitlistOpen ?? false,
          logoMediaId: dto.logoMediaId ?? null,
        };
        validateCore(core);
        if (core.logoMediaId) {
          await assertReadyMedia(tx, core.logoMediaId, actorId, ['PHOTO'], 'logoMediaId');
        }
        const t = await tx.tournament.create({
          data: {
            ...core,
            startsOn: parseDate(core.startsOn),
            endsOn: core.endsOn ? parseDate(core.endsOn) : null,
            organiserId: actorId,
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.create',
          targetType: 'Tournament',
          targetId: t.id,
          requestId,
          metadata: { duration: t.duration, feeMode: t.feeMode },
        });
        return this.view.detail(tx, actorId, t.id);
      },
    );
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateTournamentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<TournamentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.update:${id}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, id);
        const t = await this.access.loadVisible(tx, actorId, id);
        this.access.assertOrganiser(actorId, t);
        if (dto.version !== t.version) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'This tournament was changed elsewhere', {
            currentVersion: t.version,
          });
        }
        this.access.assertNotTerminal(t);
        const before = coreOf(t);
        const { version: _v, ...patch } = dto;
        void _v;
        const after: Core = { ...before };
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (after as unknown as Record<string, unknown>)[k] = v;
        }
        if (after.ageBand === 'NONE') after.allowYounger = false;
        if (after.duration === 'ONE_DAY' && patch.endsOn === undefined) {
          after.endsOn = after.startsOn;
        }
        validateCore(after);

        const changed = (Object.keys(after) as (keyof Core)[]).filter(
          (k) => after[k] !== before[k],
        );
        if (t.status === 'LIVE') {
          const allowed: (keyof Core)[] = ['name', 'description', 'logoMediaId', 'isPublic'];
          if (changed.some((k) => !allowed.includes(k))) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'Only the name, description and logo can change once live',
              {
                status: t.status,
              },
            );
          }
        }
        if (t.status !== 'DRAFT' && changed.some((k) => MATERIAL.includes(k))) {
          const entries = await tx.clubEntry.count({
            where: { tournamentId: id, status: { in: [...ACTIVE_ENTRY] } },
          });
          if (entries > 0) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'Format, price and eligibility cannot change while clubs are entered; this needs a separate published change',
              { reason: 'MATERIAL_CHANGE', fields: changed.filter((k) => MATERIAL.includes(k)) },
            );
          }
        }
        if (after.maxClubs !== null && changed.includes('maxClubs')) {
          const taken = await tx.clubEntry.count({
            where: { tournamentId: id, status: { in: ['ACCEPTED', 'INVITED'] } },
          });
          if (taken > after.maxClubs) {
            throw new ApiError(
              ErrorCode.CAPACITY_CHANGED,
              'More clubs are accepted or invited than this limit',
              {
                taken,
              },
            );
          }
        }
        if (after.logoMediaId && after.logoMediaId !== before.logoMediaId) {
          await assertReadyMedia(tx, after.logoMediaId, actorId, ['PHOTO'], 'logoMediaId');
        }
        await tx.tournament.update({
          where: { id },
          data: {
            ...after,
            startsOn: parseDate(after.startsOn),
            endsOn: after.endsOn ? parseDate(after.endsOn) : null,
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.update',
          targetType: 'Tournament',
          targetId: id,
          requestId,
          metadata: { changed },
        });
        if (t.publishedAt && changed.some((k) => ['startsOn', 'endsOn', 'city'].includes(k))) {
          await this.notifyEntrants(
            tx,
            t,
            actorId,
            'Tournament dates or place changed',
            'tournament.changed',
          );
        }
        return this.view.detail(tx, actorId, id);
      },
    );
  }

  // ───────────── reads ─────────────

  async get(viewerId: string | null, id: string): Promise<TournamentDto> {
    return this.view.detail(this.prisma, viewerId, id);
  }

  async list(viewerId: string | null, q: TournamentListQuery): Promise<TournamentPageDto> {
    const limit = clampPageSize(q.limit);
    const and: Prisma.TournamentWhereInput[] = [];
    const mine = q.mine === 'true' || q.mine === '1';

    let assistantOf: string[] = [];
    if (viewerId) {
      const grants = await this.prisma.roleGrant.findMany({
        where: {
          granteeId: viewerId,
          resourceType: 'TOURNAMENT',
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }],
        },
        select: { resourceId: true },
      });
      assistantOf = grants.flatMap((g) => (g.resourceId ? [g.resourceId] : []));
    }
    const involved: Prisma.TournamentWhereInput[] = viewerId
      ? [
          { organiserId: viewerId },
          { id: { in: assistantOf } },
          {
            status: { not: 'DRAFT' },
            entries: {
              some: {
                OR: [
                  { submittedById: viewerId },
                  { club: { ownerId: viewerId } },
                  { players: { some: { userId: viewerId } } },
                ],
              },
            },
          },
        ]
      : [];
    if (mine) {
      if (!viewerId) return { items: [], nextCursor: null };
      and.push({ OR: involved });
    } else {
      and.push({
        OR: [{ isPublic: true, publishedAt: { not: null }, status: { not: 'DRAFT' } }, ...involved],
      });
    }
    const statuses = csv(q.status).filter((s): s is TournamentStatus =>
      [
        'DRAFT',
        'REGISTRATION_OPEN',
        'REGISTRATION_CLOSED',
        'LIVE',
        'FINISHED',
        'POSTPONED',
        'CANCELLED',
      ].includes(s),
    );
    if (statuses.length) and.push({ status: { in: statuses } });
    else if ((q.when ?? 'UPCOMING') === 'UPCOMING') {
      and.push({ status: { notIn: TERMINAL } });
    }
    if (q.city) and.push({ city: { equals: q.city, mode: 'insensitive' } });
    const formats = csv(q.formats)
      .map(Number)
      .filter((n) => Number.isInteger(n));
    if (formats.length) and.push({ formatPlayers: { in: formats } });
    if (q.ageBand) and.push({ ageBand: q.ageBand });
    if (q.organiserId) and.push({ organiserId: q.organiserId });
    if (q.from)
      and.push({
        OR: [
          { endsOn: { gte: parseDate(q.from) } },
          { endsOn: null, startsOn: { gte: parseDate(q.from) } },
        ],
      });
    if (q.to) and.push({ startsOn: { lte: parseDate(q.to) } });
    if (viewerId) {
      const blocks = await this.prisma.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      const hidden = blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
      if (hidden.length) and.push({ organiserId: { notIn: hidden } });
    }
    const desc = q.when === 'ANY' && !q.from;
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      const d = new Date(cursor.t);
      and.push(
        desc
          ? { OR: [{ startsOn: { lt: d } }, { startsOn: d, id: { lt: cursor.id } }] }
          : { OR: [{ startsOn: { gt: d } }, { startsOn: d, id: { gt: cursor.id } }] },
      );
    }
    const rows = await this.prisma.tournament.findMany({
      where: { AND: and },
      orderBy: [{ startsOn: desc ? 'desc' : 'asc' }, { id: desc ? 'desc' : 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: await this.view.cards(this.prisma, page),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.startsOn.toISOString(), id: last.id }) : null,
    };
  }

  // ───────────── lifecycle ─────────────

  private async transition(
    actorId: string,
    id: string,
    scope: string,
    key: string | undefined,
    payload: unknown,
    work: (tx: Tx, t: Tournament) => Promise<TournamentDto | null>,
  ): Promise<TournamentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.${scope}:${id}`, key, payload },
      async (tx) => {
        await lockTournament(tx, id);
        const t = await this.access.loadVisible(tx, actorId, id);
        this.access.assertOrganiser(actorId, t);
        const res = await work(tx, t);
        return res ?? this.view.detail(tx, actorId, id);
      },
    );
  }

  private async setStatus(
    tx: Tx,
    t: Tournament,
    to: TournamentStatus,
    actorId: string,
    action: string,
    requestId: string | undefined,
    extra: Prisma.TournamentUpdateInput = {},
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.tournament.update({
      where: { id: t.id },
      data: { ...extra, status: to, version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      actorId,
      action,
      targetType: 'Tournament',
      targetId: t.id,
      requestId,
      metadata: { from: t.status, to, ...metadata },
    });
  }

  private conflict(t: Tournament, msg: string): ApiError {
    return new ApiError(ErrorCode.CONFLICT, msg, { status: t.status });
  }

  async publish(actorId: string, id: string, key: string | undefined, requestId?: string) {
    return this.transition(actorId, id, 'publish', key, {}, async (tx, t) => {
      if (t.status !== 'DRAFT') {
        if (t.publishedAt && t.status !== 'CANCELLED') return null;
        throw this.conflict(t, 'Only a draft can be published');
      }
      const end = t.endsOn ?? t.startsOn;
      const today = localDateParts(this.clock.now(), t.timezone);
      const todayStr = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
      if (isoDate(end) < todayStr) {
        throw new ApiError(
          ErrorCode.VALIDATION,
          'A published tournament cannot be entirely in the past',
          {
            field: 'startsOn',
          },
        );
      }
      // Publishing opens registration; full entries, consents and bookings are NOT required.
      await this.setStatus(tx, t, 'REGISTRATION_OPEN', actorId, 'tournament.publish', requestId, {
        publishedAt: this.clock.now(),
      });
      return null;
    });
  }

  async closeRegistration(
    actorId: string,
    id: string,
    key: string | undefined,
    requestId?: string,
  ) {
    return this.transition(actorId, id, 'close', key, {}, async (tx, t) => {
      if (t.status === 'REGISTRATION_CLOSED') return null;
      if (t.status !== 'REGISTRATION_OPEN') throw this.conflict(t, 'Registration is not open');
      await this.setStatus(
        tx,
        t,
        'REGISTRATION_CLOSED',
        actorId,
        'tournament.close_registration',
        requestId,
      );
      await this.notifyEntrants(
        tx,
        t,
        actorId,
        'Registration closed',
        'tournament.registration_closed',
      );
      return null;
    });
  }

  async openRegistration(actorId: string, id: string, key: string | undefined, requestId?: string) {
    return this.transition(actorId, id, 'reopen', key, {}, async (tx, t) => {
      if (t.status === 'REGISTRATION_OPEN') return null;
      if (t.status !== 'REGISTRATION_CLOSED')
        throw this.conflict(t, 'Registration cannot be reopened');
      await this.setStatus(
        tx,
        t,
        'REGISTRATION_OPEN',
        actorId,
        'tournament.reopen_registration',
        requestId,
      );
      return null;
    });
  }

  /** Problems that stop the tournament from starting (nothing changes when there are any). */
  async startProblems(db: Tx | PrismaService, t: Tournament): Promise<ProblemDto[]> {
    const problems: ProblemDto[] = [];
    const entries = await db.clubEntry.findMany({
      where: { tournamentId: t.id, status: 'ACCEPTED' },
      include: { players: true, club: { select: { name: true } } },
    });
    const minClubs = t.minClubs ?? 2;
    if (entries.length < minClubs) {
      problems.push({
        code: 'NOT_ENOUGH_CLUBS',
        message: `${entries.length} accepted club(s); at least ${minClubs} needed`,
      });
    }
    const ready = await this.readiness.forEntries(db, t, entries);
    for (const e of entries) {
      for (const p of ready.get(e.id)?.problems ?? []) {
        problems.push({ ...p, message: `${e.club.name}: ${p.message}` });
      }
    }
    const fixtures = await db.fixture.findMany({
      where: {
        tournamentId: t.id,
        startsAt: { not: null },
        endsAt: { not: null },
        status: { in: ['SCHEDULED', 'LIVE'] },
      },
      select: {
        id: true,
        pitchId: true,
        startsAt: true,
        endsAt: true,
        homeEntryId: true,
        awayEntryId: true,
      },
    });
    const slots = fixtures.map((f) => ({
      id: f.id,
      pitchId: f.pitchId,
      start: (f.startsAt as Date).getTime(),
      end: (f.endsAt as Date).getTime(),
      clubs: [f.homeEntryId, f.awayEntryId].filter((x): x is string => x !== null),
    }));
    for (const c of analyseSchedule(slots, 0).conflicts) {
      if (c.type === 'REST_TOO_SHORT') continue;
      problems.push({ code: c.type, message: c.message, fixtureId: c.fixtureIds[1] });
    }
    // rentals: lost / unconfirmed / foreign-occupied pitches surface here (UNBOOKED is only a warning)
    const timed = await db.fixture.findMany({
      where: {
        tournamentId: t.id,
        status: { in: ['SCHEDULED', 'LIVE'] },
        pitchId: { not: null },
        startsAt: { not: null },
        endsAt: { not: null },
      },
      select: { id: true, pitchId: true, startsAt: true, endsAt: true },
    });
    const rental = await this.rentals.evaluate(
      db,
      t.id,
      timed.map((f) => ({
        fixtureId: f.id,
        pitchId: f.pitchId as string,
        start: (f.startsAt as Date).getTime(),
        end: (f.endsAt as Date).getTime(),
      })),
    );
    for (const r of rental.problems) {
      problems.push({ code: r.code, message: r.message, fixtureId: r.fixtureId });
    }
    for (const s of await this.structure.problems(db, t.id)) {
      problems.push({ code: s.code, message: s.message });
    }
    return problems;
  }

  async start(actorId: string, id: string, key: string | undefined, requestId?: string) {
    return this.transition(actorId, id, 'start', key, {}, async (tx, t) => {
      if (t.status === 'LIVE') return null;
      if (!['REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(t.status)) {
        throw this.conflict(t, 'This tournament cannot be started from its current status');
      }
      const problems = await this.startProblems(tx, t);
      if (problems.length > 0) {
        throw new ApiError(ErrorCode.CONFLICT, 'The tournament is not ready to start', {
          reason: 'NOT_READY',
          problems: problems as unknown as Prisma.InputJsonValue,
        });
      }
      await this.setStatus(tx, t, 'LIVE', actorId, 'tournament.start', requestId);
      await this.notifyEntrants(tx, t, actorId, 'The tournament has started', 'tournament.started');
      return null;
    });
  }

  async finish(
    actorId: string,
    id: string,
    dto: FinishTournamentDto,
    key: string | undefined,
    requestId?: string,
  ) {
    return this.transition(actorId, id, 'finish', key, dto, async (tx, t) => {
      if (t.status === 'FINISHED') return null;
      if (t.status !== 'LIVE') throw this.conflict(t, 'Only a live tournament can be finished');
      const open = await tx.fixture.count({
        where: { tournamentId: id, status: { in: ['SCHEDULED', 'LIVE'] } },
      });
      if (open > 0 && !dto.confirmUnplayed) {
        throw new ApiError(ErrorCode.CONFLICT, 'Some fixtures are not played', {
          reason: 'UNPLAYED_FIXTURES',
          unplayed: open,
        });
      }
      await this.setStatus(
        tx,
        t,
        'FINISHED',
        actorId,
        'tournament.finish',
        requestId,
        {},
        { unplayed: open },
      );
      await this.notifyEntrants(
        tx,
        t,
        actorId,
        'The tournament has finished',
        'tournament.finished',
      );
      return null;
    });
  }

  async postpone(
    actorId: string,
    id: string,
    dto: PostponeTournamentDto,
    key: string | undefined,
    requestId?: string,
  ) {
    return this.transition(actorId, id, 'postpone', key, dto, async (tx, t) => {
      if (t.status === 'POSTPONED') return null;
      if (!['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE'].includes(t.status)) {
        throw this.conflict(t, 'This tournament cannot be postponed');
      }
      const startsOn = dto.startsOn ?? isoDate(t.startsOn);
      const endsOn =
        dto.endsOn ?? (t.duration === 'ONE_DAY' ? startsOn : t.endsOn ? isoDate(t.endsOn) : null);
      if (endsOn && endsOn < startsOn) {
        throw new ApiError(ErrorCode.VALIDATION, 'endsOn must be on or after startsOn', {
          field: 'endsOn',
        });
      }
      await this.setStatus(
        tx,
        t,
        'POSTPONED',
        actorId,
        'tournament.postpone',
        requestId,
        {
          startsOn: parseDate(startsOn),
          endsOn: endsOn ? parseDate(endsOn) : null,
        },
        { reason: dto.reason },
      );
      await this.notifyEntrants(
        tx,
        t,
        actorId,
        'The tournament was postponed',
        'tournament.postponed',
      );
      return null;
    });
  }

  async resume(actorId: string, id: string, key: string | undefined, requestId?: string) {
    return this.transition(actorId, id, 'resume', key, {}, async (tx, t) => {
      if (t.status !== 'POSTPONED') {
        if (['REGISTRATION_OPEN', 'LIVE'].includes(t.status)) return null;
        throw this.conflict(t, 'Only a postponed tournament can resume');
      }
      const played = await tx.fixture.count({
        where: { tournamentId: id, status: { in: ['FINISHED', 'LIVE'] } },
      });
      const to: TournamentStatus = played > 0 ? 'LIVE' : 'REGISTRATION_OPEN';
      await this.setStatus(tx, t, to, actorId, 'tournament.resume', requestId);
      await this.notifyEntrants(tx, t, actorId, 'The tournament resumes', 'tournament.resumed');
      return null;
    });
  }

  async cancel(
    actorId: string,
    id: string,
    dto: CancelTournamentDto,
    key: string | undefined,
    requestId?: string,
  ) {
    return this.transition(actorId, id, 'cancel', key, dto, async (tx, t) => {
      if (t.status === 'CANCELLED') return null;
      if (t.status === 'FINISHED')
        throw this.conflict(t, 'A finished tournament cannot be cancelled');
      await this.setStatus(
        tx,
        t,
        'CANCELLED',
        actorId,
        'tournament.cancel',
        requestId,
        {},
        { reason: dto.reason },
      );
      // History stays: played fixtures keep their results, the rest are cancelled.
      await tx.fixture.updateMany({
        where: { tournamentId: id, status: { in: ['SCHEDULED', 'LIVE', 'POSTPONED'] } },
        data: { status: 'CANCELLED' },
      });
      // Unpaid fees vanish; anything paid becomes "Refund due" (not "Refunded").
      await settleObligations(
        tx,
        { tournamentId: id },
        actorId,
        dto.reason ?? 'Tournament cancelled',
      );
      await this.notifyEntrants(
        tx,
        t,
        actorId,
        'The tournament was cancelled',
        'tournament.cancelled',
      );
      return null;
    });
  }

  /** Reps of active entries and their invited/confirmed players. */
  async notifyEntrants(
    tx: Tx,
    t: Pick<Tournament, 'id'>,
    actorId: string,
    title: string,
    kind: string,
  ): Promise<void> {
    const entries = await tx.clubEntry.findMany({
      where: { tournamentId: t.id, status: { in: [...ACTIVE_ENTRY] } },
      include: { players: { where: { status: { in: ['INVITED', 'CONFIRMED'] } } } },
    });
    const recipients = new Set<string>();
    for (const e of entries) {
      for (const r of await this.access.clubRepresentatives(tx, e.clubId)) recipients.add(r);
      recipients.add(e.submittedById);
      e.players.forEach((p) => recipients.add(p.userId));
    }
    await this.notifier.notify(tx, {
      recipientIds: [...recipients],
      category: 'tournament',
      activityKind: kind,
      title,
      objectType: 'Tournament',
      objectId: t.id,
      actorId,
      essential: true,
      payload: { tournamentId: t.id },
      dedupeKey: `${kind}:${t.id}:${this.clock.now().getTime()}`,
    });
  }

  // ───────────── assistants (grants via AccessService) ─────────────

  async appoint(
    actorId: string,
    id: string,
    dto: AppointAssistantDto,
    requestId?: string,
  ): Promise<AssistantsDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, id);
    this.access.assertOrganiser(actorId, t);
    if (t.status === 'DRAFT' || !t.publishedAt) {
      throw new ApiError(ErrorCode.CONFLICT, 'Assistants can only be appointed after publication');
    }
    this.access.assertNotTerminal(t);
    const now = this.clock.now();
    const existing = await this.prisma.roleGrant.findMany({
      where: {
        granteeId: dto.userId,
        resourceType: 'TOURNAMENT',
        resourceId: id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { permission: true },
    });
    const have = new Set(existing.map((g) => g.permission));
    for (const p of dto.permissions) {
      if (have.has(p)) continue;
      await this.accessGrants.create(
        actorId,
        { granteeId: dto.userId, resourceType: 'TOURNAMENT', resourceId: id, permission: p },
        requestId,
      );
    }
    return this.assistants(actorId, id);
  }

  async assistants(actorId: string, id: string): Promise<AssistantsDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, id);
    this.access.assertOrganiser(actorId, t);
    const grants = await this.prisma.roleGrant.findMany({
      where: {
        resourceType: 'TOURNAMENT',
        resourceId: id,
        revokedAt: null,
        permission: { in: [...ASSISTANT_PERMISSIONS] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    const people = await loadPersonSummaries(
      this.prisma,
      grants.map((g) => g.granteeId),
    );
    const by = new Map<string, { permissions: string[]; at: Date }>();
    for (const g of grants) {
      const cur = by.get(g.granteeId);
      if (cur) cur.permissions.push(g.permission);
      else by.set(g.granteeId, { permissions: [g.permission as PermissionName], at: g.createdAt });
    }
    return {
      limit: 2,
      items: [...by.entries()].map(([userId, v]) => ({
        userId,
        person: personOrUnknown(people, userId),
        permissions: v.permissions.sort(),
        appointedAt: v.at.toISOString(),
      })),
    };
  }

  async dismiss(
    actorId: string,
    id: string,
    userId: string,
    requestId?: string,
  ): Promise<RevokedDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, id);
    this.access.assertOrganiser(actorId, t);
    const grants = await this.prisma.roleGrant.findMany({
      where: {
        granteeId: userId,
        resourceType: 'TOURNAMENT',
        resourceId: id,
        revokedAt: null,
      },
      select: { id: true },
    });
    let revoked = 0;
    for (const g of grants) {
      const r = await this.accessGrants.revoke(actorId, g.id, 'Assistant removed', requestId);
      revoked += r.revoked;
    }
    return { revoked };
  }
}
