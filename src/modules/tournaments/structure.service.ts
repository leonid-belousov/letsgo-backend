import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, Tournament, TournamentStage } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type {
  BracketsDto,
  CreateFixtureDto,
  CreateStageDto,
  DrawDto,
  FixtureDto,
  FixtureListDto,
  FixtureListQuery,
  GenerateResultDto,
  StageDto,
  StageProblemDto,
  StandingsDto,
  UpdateStageDto,
} from './dto/structure.dto';
import { FixtureViewService, knockoutPos } from './fixture-view.service';
import { buildBracket, pairsFromSeeds, roundLabel, type Source } from './logic/bracket';
import { roundRobin } from './logic/round-robin';
import {
  isRankRef,
  mergeConfig,
  parseClientConfig,
  readConfig,
  type SeedRef,
  type StageConfigBase,
} from './logic/stage-config';
import { ResultsService } from './results.service';
import { NOT_AVAILABLE, TournamentAccess, lockTournament } from './tournament-access.service';

const asJson = (c: StageConfigBase): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(c)) as Prisma.InputJsonObject;

function rng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

@Injectable()
export class StructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly idempotency: IdempotencyService,
    private readonly results: ResultsService,
    private readonly view: FixtureViewService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── validation ─────────────

  /**
   * Cross-stage structure problems: a group rank feeding two cups, a non-existent position,
   * a cycle/forward reference, or a draw that no longer matches the accepted clubs. The
   * grid is NEVER adapted silently to a changed number of clubs (Decisions §44.3).
   */
  async problems(db: Db, tournamentId: string): Promise<StageProblemDto[]> {
    const stages = await db.tournamentStage.findMany({
      where: { tournamentId },
      orderBy: { index: 'asc' },
    });
    const accepted = await db.clubEntry.findMany({
      where: { tournamentId, status: 'ACCEPTED' },
      select: { id: true },
    });
    const acceptedIds = new Set(accepted.map((a) => a.id));
    const byIndex = new Map(stages.map((s) => [s.index, s]));
    const out: StageProblemDto[] = [];
    const feeds = new Map<string, number>();
    const entriesSeen = new Map<string, number>();

    for (const s of stages) {
      const cfg = readConfig(s.config);
      if (s.kind === 'GROUP' || s.kind === 'LEAGUE') {
        for (const ids of Object.values(cfg.assignments ?? {})) {
          for (const id of ids) {
            if (!acceptedIds.has(id)) {
              out.push({
                code: 'ASSIGNMENT_STALE',
                stageIndex: s.index,
                message: `${s.name}: a drawn club is no longer accepted; redraw the stage`,
              });
              break;
            }
          }
        }
      }
      if (s.kind !== 'KNOCKOUT') continue;
      const refs: SeedRef[] = [
        ...(cfg.pairs?.flatMap(([a, b]) => (b ? [a, b] : [a])) ?? []),
        ...(cfg.participants ?? []),
      ];
      for (const r of refs) {
        if (!isRankRef(r)) {
          entriesSeen.set(r.entryId, (entriesSeen.get(r.entryId) ?? 0) + 1);
          continue;
        }
        const src = byIndex.get(r.stage);
        if (!src || src.kind === 'KNOCKOUT' || src.kind === 'CUSTOM' || r.stage >= s.index) {
          out.push({
            code: 'STAGE_REF_INVALID',
            stageIndex: s.index,
            message: `${s.name}: stage ${r.stage} cannot feed this stage (it must be an earlier group or league)`,
          });
          continue;
        }
        const scfg = readConfig(src.config);
        const groupOk =
          src.kind === 'GROUP' ? (scfg.groups ?? []).includes(r.group) : r.group === '';
        if (!groupOk) {
          out.push({
            code: 'GROUP_MISSING',
            stageIndex: s.index,
            message: `${s.name}: stage ${r.stage} has no group "${r.group}"`,
          });
          continue;
        }
        const size = scfg.assignments?.[r.group]?.length;
        if (size !== undefined && r.rank > size) {
          out.push({
            code: 'POSITION_MISSING',
            stageIndex: s.index,
            message: `${s.name}: position ${r.group}${r.rank} does not exist (the group has ${size} clubs)`,
          });
        }
        const k = `${r.stage}|${r.group}|${r.rank}`;
        feeds.set(k, (feeds.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of feeds) {
      if (n > 1) {
        const [st, g, r] = k.split('|');
        out.push({
          code: 'RANK_FEEDS_TWO_CUPS',
          message: `Position ${g}${r} of stage ${st} feeds more than one place; each group position may feed exactly one cup`,
        });
      }
    }
    for (const [id, n] of entriesSeen) {
      if (n > 1)
        out.push({
          code: 'ENTRY_DUPLICATED',
          message: `Club entry ${id} is placed more than once in knockouts`,
        });
    }
    return out;
  }

  private async assertNoProblems(tx: Tx, tournamentId: string): Promise<void> {
    const p = await this.problems(tx, tournamentId);
    if (p.length > 0) {
      throw new ApiError(ErrorCode.CONFLICT, 'The competition structure has conflicts', {
        reason: 'STRUCTURE_CONFLICT',
        problems: p as unknown as Prisma.InputJsonValue,
      });
    }
  }

  // ───────────── helpers ─────────────

  private async gate(tx: Db, actorId: string, tournamentId: string): Promise<Tournament> {
    const t = await this.access.loadVisible(tx, actorId, tournamentId);
    await this.access.assertCan(tx, actorId, 'tournament.schedule', t);
    this.access.assertNotTerminal(t);
    return t;
  }

  private async mustStage(db: Db, tournamentId: string, stageId: string): Promise<TournamentStage> {
    const s = await db.tournamentStage.findUnique({ where: { id: stageId } });
    if (!s || s.tournamentId !== tournamentId)
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return s;
  }

  private async stageDto(db: Db, s: TournamentStage): Promise<StageDto> {
    const [fixtureCount, playedCount] = await Promise.all([
      db.fixture.count({ where: { stageId: s.id } }),
      db.fixture.count({ where: { stageId: s.id, status: { in: ['FINISHED', 'LIVE'] } } }),
    ]);
    return {
      id: s.id,
      index: s.index,
      name: s.name,
      kind: s.kind,
      config: s.config as Record<string, unknown>,
      fixtureCount,
      playedCount,
    };
  }

  private async assertUnplayed(tx: Db, stageId: string): Promise<void> {
    const played = await tx.fixture.count({
      where: { stageId, status: { in: ['FINISHED', 'LIVE'] } },
    });
    if (played > 0) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'Played matches are never rebuilt; this stage already has results',
        {
          reason: 'STAGE_HAS_RESULTS',
        },
      );
    }
  }

  // ───────────── stages ─────────────

  async listStages(viewerId: string | null, tournamentId: string): Promise<StageDto[]> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    const stages = await this.prisma.tournamentStage.findMany({
      where: { tournamentId: t.id },
      orderBy: { index: 'asc' },
    });
    const manager = viewerId
      ? await this.access.canAny(this.prisma, viewerId, ['tournament.schedule'], t)
      : false;
    const dtos = await Promise.all(stages.map((s) => this.stageDto(this.prisma, s)));
    // drawing seed / internals are visible to managers only
    return dtos.map((d) => (manager ? d : { ...d, config: this.publicConfig(d.config) }));
  }

  private publicConfig(c: Record<string, unknown>): Record<string, unknown> {
    const { draw: _d, tieResolutions: _t, ...rest } = c;
    void _d;
    void _t;
    return rest;
  }

  async check(actorId: string, tournamentId: string): Promise<StageProblemDto[]> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    await this.access.assertCan(this.prisma, actorId, 'tournament.schedule', t);
    return this.problems(this.prisma, tournamentId);
  }

  async createStage(
    actorId: string,
    tournamentId: string,
    dto: CreateStageDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<StageDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.stage.create:${tournamentId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        await this.gate(tx, actorId, tournamentId);
        const config = parseClientConfig(dto.kind, dto.config);
        const last = await tx.tournamentStage.aggregate({
          where: { tournamentId },
          _max: { index: true },
        });
        const stage = await tx.tournamentStage.create({
          data: {
            tournamentId,
            index: (last._max.index ?? 0) + 1,
            name: dto.name.trim(),
            kind: dto.kind,
            config: asJson(config),
          },
        });
        await this.assertNoProblems(tx, tournamentId);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.stage.create',
          targetType: 'TournamentStage',
          targetId: stage.id,
          requestId,
          metadata: { kind: dto.kind },
        });
        return this.stageDto(tx, stage);
      },
    );
  }

  async updateStage(
    actorId: string,
    tournamentId: string,
    stageId: string,
    dto: UpdateStageDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<StageDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.stage.update:${stageId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        await this.gate(tx, actorId, tournamentId);
        const s = await this.mustStage(tx, tournamentId, stageId);
        await this.assertUnplayed(tx, stageId);
        const data: Prisma.TournamentStageUpdateInput = {};
        if (dto.name) data.name = dto.name.trim();
        if (dto.config) {
          data.config = asJson(
            mergeConfig(readConfig(s.config), parseClientConfig(s.kind, dto.config)),
          );
        }
        const updated = await tx.tournamentStage.update({ where: { id: s.id }, data });
        await this.assertNoProblems(tx, tournamentId);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.stage.update',
          targetType: 'TournamentStage',
          targetId: s.id,
          requestId,
          metadata: { changed: Object.keys(dto) },
        });
        return this.stageDto(tx, updated);
      },
    );
  }

  async deleteStage(
    actorId: string,
    tournamentId: string,
    stageId: string,
    requestId?: string,
  ): Promise<{ deleted: true }> {
    return this.prisma.$transaction(async (tx) => {
      await lockTournament(tx, tournamentId);
      await this.gate(tx, actorId, tournamentId);
      const s = await this.mustStage(tx, tournamentId, stageId);
      await this.assertUnplayed(tx, stageId);
      const others = await tx.tournamentStage.findMany({
        where: { tournamentId, id: { not: stageId } },
      });
      for (const o of others) {
        const c = readConfig(o.config);
        const refs = [...(c.pairs?.flat() ?? []), ...(c.participants ?? [])];
        if (refs.some((r) => r && isRankRef(r) && r.stage === s.index)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Another stage takes its participants from this one',
            { reason: 'STAGE_IN_USE', stage: o.name },
          );
        }
      }
      await tx.tournamentStage.delete({ where: { id: stageId } });
      await this.audit.record(tx, {
        actorId,
        action: 'tournament.stage.delete',
        targetType: 'TournamentStage',
        targetId: stageId,
        requestId,
      });
      return { deleted: true as const };
    });
  }

  // ───────────── draw ─────────────

  async draw(
    actorId: string,
    tournamentId: string,
    stageId: string,
    dto: DrawDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<StageDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.stage.draw:${stageId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        await this.gate(tx, actorId, tournamentId);
        const s = await this.mustStage(tx, tournamentId, stageId);
        if (s.kind !== 'GROUP' && s.kind !== 'LEAGUE') {
          throw new ApiError(ErrorCode.VALIDATION, 'Only group and league stages are drawn');
        }
        await this.assertUnplayed(tx, stageId);
        const cfg = readConfig(s.config);
        const labels = s.kind === 'GROUP' ? (cfg.groups ?? []) : [''];
        const accepted = (
          await tx.clubEntry.findMany({
            where: { tournamentId, status: 'ACCEPTED' },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        ).map((e) => e.id);
        const pool = dto.entryIds ?? accepted;
        if (!pool.every((id) => accepted.includes(id)) || new Set(pool).size !== pool.length) {
          throw new ApiError(ErrorCode.VALIDATION, 'Only accepted clubs (each once) can be drawn', {
            field: 'entryIds',
          });
        }
        let assignments: Record<string, string[]>;
        let seed: string | null = null;
        if (dto.mode === 'MANUAL') {
          const given = dto.assignments ?? {};
          if (Object.keys(given).sort().join('|') !== [...labels].sort().join('|')) {
            throw new ApiError(ErrorCode.VALIDATION, 'Assign every group of the stage', {
              field: 'assignments',
              groups: labels,
            });
          }
          const flat = Object.values(given).flat();
          if (
            flat.length !== pool.length ||
            new Set(flat).size !== flat.length ||
            !flat.every((id) => pool.includes(id))
          ) {
            throw new ApiError(
              ErrorCode.VALIDATION,
              'Every club must be placed in exactly one group',
              { field: 'assignments' },
            );
          }
          assignments = Object.fromEntries(labels.map((l) => [l, [...(given[l] as string[])]]));
        } else {
          seed = dto.seed ?? randomBytes(8).toString('hex');
          const rand = rng(seed);
          const shuffled = [...pool];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
          }
          assignments = Object.fromEntries(labels.map((l) => [l, [] as string[]]));
          shuffled.forEach((id, i) =>
            (assignments[labels[i % labels.length] as string] as string[]).push(id),
          );
        }
        // a new draw invalidates unplayed generated fixtures of this stage
        await tx.fixture.deleteMany({ where: { stageId } });
        const next: StageConfigBase = {
          ...cfg,
          assignments,
          draw: { mode: dto.mode, seed, byId: actorId, at: this.clock.now().toISOString() },
        };
        const updated = await tx.tournamentStage.update({
          where: { id: stageId },
          data: { config: asJson(next) },
        });
        await this.results.recomputeStage(tx, stageId);
        await this.assertNoProblems(tx, tournamentId);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.stage.draw',
          targetType: 'TournamentStage',
          targetId: stageId,
          requestId,
          metadata: { mode: dto.mode, seed },
        });
        return this.stageDto(tx, updated);
      },
    );
  }

  // ───────────── fixtures generation ─────────────

  async generate(
    actorId: string,
    tournamentId: string,
    stageId: string,
    key: string | undefined,
    requestId?: string,
  ): Promise<GenerateResultDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.stage.generate:${stageId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        await this.gate(tx, actorId, tournamentId);
        const s = await this.mustStage(tx, tournamentId, stageId);
        await this.assertUnplayed(tx, stageId);
        const cfg = readConfig(s.config);
        let created: number;
        let byes = 0;
        await tx.fixture.deleteMany({ where: { stageId } });

        if (s.kind === 'GROUP' || s.kind === 'LEAGUE') {
          if (!cfg.assignments) {
            throw new ApiError(ErrorCode.CONFLICT, 'Draw the stage before generating matches', {
              reason: 'NOT_DRAWN',
            });
          }
          const rows: Prisma.FixtureCreateManyInput[] = [];
          for (const [label, ids] of Object.entries(cfg.assignments)) {
            for (const m of roundRobin(ids, cfg.rounds ?? 1)) {
              rows.push({
                tournamentId,
                stageId,
                round: m.round,
                groupLabel: s.kind === 'GROUP' ? label : null,
                homeEntryId: m.home,
                awayEntryId: m.away,
                scheduleVersion: 0,
              });
            }
          }
          await tx.fixture.createMany({ data: rows });
          created = rows.length;
        } else if (s.kind === 'KNOCKOUT') {
          const pairs = cfg.pairs ?? pairsFromSeeds(cfg.participants ?? []);
          const bracket = buildBracket(pairs, cfg.thirdPlace ?? false);
          byes = bracket.byes;
          const ids = new Map(bracket.fixtures.map((f) => [f.key, randomUUID()]));
          const entryIds = new Set(
            (await tx.clubEntry.findMany({ where: { tournamentId }, select: { id: true } })).map(
              (e) => e.id,
            ),
          );
          const side = (src: Source): { entryId: string | null; placeholder: string | null } => {
            switch (src.t) {
              case 'ENTRY':
                if (!entryIds.has(src.entryId)) {
                  throw new ApiError(ErrorCode.VALIDATION, 'Unknown club entry in the bracket', {
                    field: 'config',
                  });
                }
                return { entryId: src.entryId, placeholder: null };
              case 'RANK':
                return { entryId: null, placeholder: `RANK:${src.stage}:${src.group}:${src.rank}` };
              case 'WIN':
                return { entryId: null, placeholder: `W:${ids.get(src.key)}` };
              case 'LOSE':
                return { entryId: null, placeholder: `L:${ids.get(src.key)}` };
            }
          };
          const rows: Prisma.FixtureCreateManyInput[] = bracket.fixtures.map((f) => {
            const h = side(f.home);
            const a = side(f.away);
            return {
              id: ids.get(f.key),
              tournamentId,
              stageId,
              round: f.round,
              groupLabel: f.third ? 'THIRD' : `P${f.pos}`,
              homeEntryId: h.entryId,
              homePlaceholder: h.placeholder,
              awayEntryId: a.entryId,
              awayPlaceholder: a.placeholder,
              scheduleVersion: 0,
            };
          });
          await tx.fixture.createMany({ data: rows });
          created = rows.length;
        } else {
          throw new ApiError(ErrorCode.VALIDATION, 'Custom stages get their matches one by one');
        }
        await this.results.recomputeStage(tx, stageId);
        await this.results.resolvePlaceholders(tx, tournamentId);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.stage.generate',
          targetType: 'TournamentStage',
          targetId: stageId,
          requestId,
          metadata: { created, byes },
        });
        return { created, byes, stage: await this.stageDto(tx, s) };
      },
    );
  }

  async addFixture(
    actorId: string,
    tournamentId: string,
    stageId: string,
    dto: CreateFixtureDto,
    key: string | undefined,
  ): Promise<FixtureDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.fixture.create:${stageId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        await this.gate(tx, actorId, tournamentId);
        const s = await this.mustStage(tx, tournamentId, stageId);
        if (s.kind !== 'CUSTOM')
          throw new ApiError(
            ErrorCode.VALIDATION,
            'Matches are added by hand to custom stages only',
          );
        if (
          (!dto.homeEntryId && !dto.homePlaceholder) ||
          (!dto.awayEntryId && !dto.awayPlaceholder)
        ) {
          throw new ApiError(ErrorCode.VALIDATION, 'Each side needs a club or a placeholder');
        }
        const ids = [dto.homeEntryId, dto.awayEntryId].filter((x): x is string => !!x);
        const found = await tx.clubEntry.count({ where: { tournamentId, id: { in: ids } } });
        if (found !== ids.length) throw new ApiError(ErrorCode.VALIDATION, 'Unknown club entry');
        const f = await tx.fixture.create({
          data: {
            tournamentId,
            stageId,
            round: dto.round ?? 1,
            groupLabel: dto.groupLabel ?? null,
            homeEntryId: dto.homeEntryId ?? null,
            awayEntryId: dto.awayEntryId ?? null,
            homePlaceholder: dto.homeEntryId ? null : (dto.homePlaceholder ?? null),
            awayPlaceholder: dto.awayEntryId ? null : (dto.awayPlaceholder ?? null),
            scheduleVersion: 0,
          },
        });
        await this.results.recomputeStage(tx, stageId);
        const ctx = await this.view.context(tx, tournamentId);
        return this.view.toDto(ctx, f, true);
      },
    );
  }

  // ───────────── public reads ─────────────

  private async revealSlots(viewerId: string | null, t: Tournament): Promise<boolean> {
    return viewerId
      ? this.access.canAny(
          this.prisma,
          viewerId,
          ['tournament.schedule', 'tournament.protocols'],
          t,
        )
      : false;
  }

  async fixtures(
    viewerId: string | null,
    tournamentId: string,
    q: FixtureListQuery,
  ): Promise<FixtureListDto> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    const reveal = await this.revealSlots(viewerId, t);
    const ctx = await this.view.context(this.prisma, tournamentId);
    const entryOfClub = q.clubId
      ? (
          await this.prisma.clubEntry.findMany({
            where: { tournamentId, clubId: q.clubId },
            select: { id: true },
          })
        ).map((e) => e.id)
      : null;
    const list = ctx.fixtures.filter((f) => {
      if (q.stageId && f.stageId !== q.stageId) return false;
      if (q.status && f.status !== q.status) return false;
      if (entryOfClub && !entryOfClub.some((id) => id === f.homeEntryId || id === f.awayEntryId))
        return false;
      const visibleTime = reveal || f.scheduleVersion >= 1;
      if ((q.from || q.to) && (!visibleTime || !f.startsAt)) return false;
      if (q.from && f.startsAt && f.startsAt < q.from) return false;
      if (q.to && f.startsAt && f.startsAt >= q.to) return false;
      return true;
    });
    return { items: this.view.sort(list, ctx).map((f) => this.view.toDto(ctx, f, reveal)) };
  }

  async standings(viewerId: string | null, tournamentId: string): Promise<StandingsDto> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    const ctx = await this.view.context(this.prisma, t.id);
    const stages = [...ctx.stages.values()]
      .filter((s) => s.kind !== 'KNOCKOUT')
      .sort((a, b) => a.index - b.index);
    const rows = await this.prisma.standing.findMany({
      where: { stageId: { in: stages.map((s) => s.id) } },
    });
    return {
      stages: stages.map((s) => {
        const groups = [
          ...new Set(rows.filter((r) => r.stageId === s.id).map((r) => r.groupLabel)),
        ].sort();
        return {
          stageId: s.id,
          stageName: s.name,
          kind: s.kind,
          groups: groups.map((g) => {
            const gr = rows
              .filter((r) => r.stageId === s.id && r.groupLabel === g)
              .sort((a, b) => a.rank - b.rank || a.entryId.localeCompare(b.entryId));
            const fx = ctx.fixtures.filter(
              (f) => f.stageId === s.id && (f.groupLabel ?? '') === g && f.status !== 'CANCELLED',
            );
            const withTie = gr.map((r) => ({
              ...r,
              tied: gr.filter((x) => x.rank === r.rank).length > 1,
            }));
            return {
              label: g,
              confirmed: fx.length > 0 && fx.every((f) => f.status === 'FINISHED'),
              hasUnresolvedTie: withTie.some((r) => r.tied),
              rows: withTie.map((r) => ({
                entryId: r.entryId,
                club: ctx.clubs.get(r.entryId) ?? null,
                played: r.played,
                won: r.won,
                drawn: r.drawn,
                lost: r.lost,
                goalsFor: r.goalsFor,
                goalsAgainst: r.goalsAgainst,
                goalDifference: r.goalsFor - r.goalsAgainst,
                points: r.points,
                rank: r.rank,
                tied: r.tied,
              })),
            };
          }),
        };
      }),
    };
  }

  async brackets(viewerId: string | null, tournamentId: string): Promise<BracketsDto> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    const reveal = await this.revealSlots(viewerId, t);
    const ctx = await this.view.context(this.prisma, t.id);
    const stages = [...ctx.stages.values()]
      .filter((s) => s.kind === 'KNOCKOUT')
      .sort((a, b) => a.index - b.index);
    return {
      stages: stages.map((s) => {
        const fx = this.view.sort(
          ctx.fixtures.filter((f) => f.stageId === s.id),
          ctx,
        );
        const total = fx.length ? Math.max(...fx.map((f) => f.round)) : 0;
        const rounds = [...new Set(fx.map((f) => f.round))].sort((a, b) => a - b);
        return {
          stageId: s.id,
          stageName: s.name,
          rounds: rounds.map((r) => ({
            round: r,
            name: roundLabel(total, r, false),
            fixtures: fx
              .filter((f) => f.round === r)
              .sort((a, b) => knockoutPos(a).pos - knockoutPos(b).pos)
              .map((f) => this.view.toDto(ctx, f, reveal)),
          })),
        };
      }),
    };
  }
}
