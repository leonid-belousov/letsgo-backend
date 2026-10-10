import { z } from 'zod';

/** Comma-separated list -> trimmed, non-empty, de-duplicated values. Empty/absent -> []. */
export function parseCsv(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(raw.map((x) => x.trim()).filter((x) => x.length > 0))];
}

const csvList = z.string().optional().transform(parseCsv);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default(''),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  // scrypt cost parameter N = 2^PASSWORD_SCRYPT_LOG_N (OWASP minimum is 2^17 with r=8,p=1).
  PASSWORD_SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(16),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(8),
  THROTTLE_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(48),
  // OPEN decision #1 (casual game without a club): who may confirm cash.
  CASUAL_CASH_RECEIVER_POLICY: z.enum(['EXPLICIT_ONLY', 'ORGANISER']).default('EXPLICIT_ONLY'),
  WAITLIST_OFFER_MINUTES: z.coerce.number().int().min(1).default(30),
  // Hours after a match is confirmed during which MVP votes are accepted (Decisions 17: configurable).
  MVP_VOTING_HOURS: z.coerce.number().int().min(1).default(24),
  // Days after result confirmation/finish during which a rating may still be edited.
  RATING_EDIT_DAYS: z.coerce.number().int().min(1).default(7),
  // Seconds between in-process triggers of the persistent maintenance job (0 = disabled; use
  // `npm run maintenance:tick` or POST /v1/admin/maintenance/run from an external scheduler).
  MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(30),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  // Express 'trust proxy': 'false' (default), a hop count like '1', or a list of trusted
  // subnets/IPs like 'loopback,10.0.0.0/8'. The literal 'true' (trust everything) is refused.
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine(
      (v) => v.trim().toLowerCase() !== 'true',
      'TRUST_PROXY=true would trust spoofed headers',
    ),
  // Only in-memory throttling exists (per process). Multi-instance needs a shared store: see README.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  THROTTLE_STORAGE: z.enum(['memory']).default('memory'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Accepted ID-token audiences. Empty list => that provider is not configured (503).
  GOOGLE_CLIENT_IDS: csvList,
  APPLE_CLIENT_IDS: csvList,
  MEDIA_LOCAL_DIR: z.string().default('./.media'),
});

export type Env = z.infer<typeof schema>;

/** Used by @nestjs/config as the `validate` hook: fails fast on bad config. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
