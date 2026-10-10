import { z } from 'zod';
import { ApiError, ErrorCode } from '../../../common/errors';

/**
 * Stage configuration (stored as JSON in TournamentStage.config). Tie-break criteria that need
 * a regulation-defined procedure (head-to-head mini tables for 3+ teams, fair play weights,
 * drawing of lots) are NOT implemented: OPEN (Decisions §44.3). They are rejected, never guessed.
 */
export const IMPLEMENTED_TIEBREAKERS = [
  'points',
  'goalDifference',
  'goalsFor',
  'goalsAgainst',
  'wins',
  'headToHead',
  'fairPlay',
] as const;
export const H2H_METRICS = ['points', 'goalDifference', 'goalsFor'] as const;
export type H2hMetric = (typeof H2H_METRICS)[number];
export type TieBreaker = (typeof IMPLEMENTED_TIEBREAKERS)[number];

export const DEFAULT_TIEBREAKERS: TieBreaker[] = ['points', 'goalDifference', 'goalsFor'];

export type SeedRef = { entryId: string } | { stage: number; group: string; rank: number };

export function isRankRef(r: SeedRef): r is { stage: number; group: string; rank: number } {
  return 'stage' in r;
}

const seedRefSchema = z.union([
  z.object({ entryId: z.uuid() }).strict(),
  z
    .object({
      stage: z.number().int().min(1),
      group: z.string().max(20),
      rank: z.number().int().min(1),
    })
    .strict(),
]);

const rulesShape = {
  points: z
    .object({
      win: z.number().int().min(0).max(100),
      draw: z.number().int().min(0).max(100),
      loss: z.number().int().min(0).max(100),
    })
    .strict()
    .optional(),
  tiebreakers: z.array(z.string()).min(1).max(8).optional(),
  headToHead: z
    .object({
      metrics: z.array(z.enum(H2H_METRICS)).min(1).max(3),
      reapplyToSubgroup: z.boolean(),
    })
    .strict()
    .optional(),
  fairPlayWeights: z
    .object({ yellow: z.number().int().min(0).max(1000), red: z.number().int().min(0).max(1000) })
    .strict()
    .optional(),
  matchMinutes: z.number().int().min(1).max(240).optional(),
  changeoverMinutes: z.number().int().min(0).max(240).optional(),
  reserveMinutes: z.number().int().min(0).max(240).optional(),
  minRestMinutes: z.number().int().min(0).max(1440).optional(),
};

const groupSchema = z
  .object({
    ...rulesShape,
    groups: z.array(z.string().min(1).max(20)).min(1).max(32),
    rounds: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

const leagueSchema = z
  .object({ ...rulesShape, rounds: z.union([z.literal(1), z.literal(2)]).optional() })
  .strict();

const knockoutSchema = z
  .object({
    ...rulesShape,
    thirdPlace: z.boolean().optional(),
    pairs: z
      .array(z.tuple([seedRefSchema, seedRefSchema.nullable()]))
      .min(1)
      .max(64)
      .optional(),
    participants: z.array(seedRefSchema).min(2).max(128).optional(),
  })
  .strict();

const customSchema = z.object({ ...rulesShape }).strict();

export interface Rules {
  points: { win: number; draw: number; loss: number };
  tiebreakers: TieBreaker[];
  headToHead?: { metrics: H2hMetric[]; reapplyToSubgroup: boolean };
  fairPlayWeights?: { yellow: number; red: number };
  matchMinutes?: number;
  changeoverMinutes?: number;
  reserveMinutes?: number;
  minRestMinutes?: number;
}

/** Persisted state managed by the system (never accepted from clients). */
export interface StageState {
  assignments?: Record<string, string[]>;
  draw?: { mode: 'MANUAL' | 'RANDOM'; seed: string | null; byId: string; at: string };
  shootouts?: Record<string, { home: number; away: number }>;
  tieResolutions?: {
    group: string;
    entryIds: string[];
    byId: string;
    at: string;
    reason: string | null;
  }[];
}

export interface StageConfigBase extends Rules, StageState {
  groups?: string[];
  rounds?: 1 | 2;
  thirdPlace?: boolean;
  pairs?: [SeedRef, SeedRef | null][];
  participants?: SeedRef[];
}

const CLIENT_KEYS: Record<'GROUP' | 'LEAGUE' | 'KNOCKOUT' | 'CUSTOM', z.ZodType> = {
  GROUP: groupSchema,
  LEAGUE: leagueSchema,
  KNOCKOUT: knockoutSchema,
  CUSTOM: customSchema,
};

/** Validates client-supplied config and fills rule defaults. System-managed state is preserved separately. */
export function parseClientConfig(
  kind: 'GROUP' | 'LEAGUE' | 'KNOCKOUT' | 'CUSTOM',
  raw: unknown,
): StageConfigBase {
  const res = CLIENT_KEYS[kind].safeParse(raw ?? {});
  if (!res.success) {
    throw new ApiError(ErrorCode.VALIDATION, 'Invalid stage configuration', {
      field: 'config',
      issues: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const cfg = res.data as StageConfigBase;
  const tiebreakers = cfg.tiebreakers ?? DEFAULT_TIEBREAKERS;
  for (const t of tiebreakers) {
    if (!(IMPLEMENTED_TIEBREAKERS as readonly string[]).includes(t)) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        `Tie-break criterion "${t}" is not supported (playoff draw resolution beyond a recorded shoot-out and organiser-recorded lots is an OPEN decision)`,
        { field: 'config.tiebreakers', supported: [...IMPLEMENTED_TIEBREAKERS] },
      );
    }
  }
  if (tiebreakers.includes('headToHead')) {
    const h = cfg.headToHead;
    if (!h) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        'headToHead needs config.headToHead = {metrics, reapplyToSubgroup}: the regulation must say which mini-table metrics are used and whether it is reapplied to the remaining subgroup',
        { field: 'config.headToHead', reason: 'HEAD_TO_HEAD_CONFIG_REQUIRED' },
      );
    }
    if (new Set(h.metrics).size !== h.metrics.length) {
      throw new ApiError(ErrorCode.VALIDATION, 'Duplicate head-to-head metrics', {
        field: 'config.headToHead.metrics',
      });
    }
  }
  if (tiebreakers.includes('fairPlay') && !cfg.fairPlayWeights) {
    throw new ApiError(
      ErrorCode.VALIDATION,
      'fairPlay needs config.fairPlayWeights = {yellow, red} (card weights set by the regulation)',
      { field: 'config.fairPlayWeights', reason: 'FAIR_PLAY_WEIGHTS_REQUIRED' },
    );
  }
  if (new Set(tiebreakers).size !== tiebreakers.length) {
    throw new ApiError(ErrorCode.VALIDATION, 'Duplicate tie-break criteria', {
      field: 'config.tiebreakers',
    });
  }
  if (kind === 'GROUP') {
    const groups = cfg.groups ?? [];
    if (new Set(groups).size !== groups.length) {
      throw new ApiError(ErrorCode.VALIDATION, 'Group labels must be unique', {
        field: 'config.groups',
      });
    }
  }
  if (kind === 'KNOCKOUT') {
    if (!cfg.pairs && !cfg.participants) {
      throw new ApiError(ErrorCode.VALIDATION, 'A knockout needs either pairs or participants', {
        field: 'config',
      });
    }
    if (cfg.pairs && cfg.participants) {
      throw new ApiError(ErrorCode.VALIDATION, 'Give either pairs or participants, not both', {
        field: 'config',
      });
    }
  }
  return {
    ...cfg,
    points: cfg.points ?? { win: 3, draw: 1, loss: 0 },
    tiebreakers: tiebreakers as TieBreaker[],
  };
}

/** Reads a stored config defensively (system-managed parts included). */
export function readConfig(raw: unknown): StageConfigBase {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<StageConfigBase>;
  return {
    ...o,
    points: o.points ?? { win: 3, draw: 1, loss: 0 },
    tiebreakers: (o.tiebreakers as TieBreaker[] | undefined) ?? DEFAULT_TIEBREAKERS,
  };
}

/** Client fields ← replaced; system state ← kept. */
export function mergeConfig(existing: StageConfigBase, client: StageConfigBase): StageConfigBase {
  const state: StageState = {
    assignments: existing.assignments,
    draw: existing.draw,
    shootouts: existing.shootouts,
    tieResolutions: existing.tieResolutions,
  };
  return { ...client, ...stripUndefined(state) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
