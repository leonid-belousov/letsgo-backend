import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BookingsService } from '../bookings/bookings.service';
import { GamesMaintenanceService, type MaintenanceReport } from '../games/maintenance.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface MaintenanceRunResult {
  status: 'OK' | 'SKIPPED' | 'FAILED';
  runId: string | null;
  games?: MaintenanceReport;
  notifications?: { sent: number; failed: number };
  expiredBookingHolds?: number;
  cleaned?: { idempotencyKeys: number; nonces: number };
}

/** Fixed key of the cluster-wide advisory lock that serialises maintenance across instances. */
const LOCK_KEY = 7_303_001;

/**
 * The single, persistent maintenance entry point (TECH: no broker). ALL state lives in PostgreSQL:
 *  - deadlines/holds/offers/auto-cancel are derived from timestamps, never from process memory;
 *  - an advisory lock makes concurrent invocations (several instances, a cron CLI, a manual POST)
 *    collapse into one execution — the others report SKIPPED;
 *  - every execution is recorded in JobRun (restart-safe audit of what ran and what it did);
 *  - each step is idempotent, so running twice — or crashing mid-way — duplicates nothing.
 * Schedulers only need to call `runOnce()`: the built-in interval (MAINTENANCE_INTERVAL_SECONDS),
 * `npm run maintenance:tick`, or `POST /v1/admin/maintenance/run`.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly games: GamesMaintenanceService,
    private readonly notifications: NotificationsService,
    private readonly bookings: BookingsService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('MAINTENANCE_INTERVAL_SECONDS', { infer: true });
    if (this.config.get('NODE_ENV', { infer: true }) === 'test' || seconds <= 0) return;
    // The timer is only a *trigger*; correctness lives in the database (see class comment).
    this.timer = setInterval(() => {
      this.runOnce().catch((e: unknown) =>
        this.log.error(e instanceof Error ? e.message : String(e)),
      );
    }, seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** `scope.eventIds` is for tests sharing a database; production calls it without arguments. */
  async runOnce(scope?: { eventIds?: string[] }): Promise<MaintenanceRunResult> {
    return this.prisma.$transaction(
      async (lockTx) => {
        const lockRows = await lockTx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
        if (!lockRows[0]?.locked) return { status: 'SKIPPED', runId: null } as MaintenanceRunResult;

        const run = await this.prisma.jobRun.create({
          data: { job: 'maintenance', startedAt: this.clock.now() },
        });
        try {
          const now = this.clock.now();
          const games = await this.games.tick(scope);
          const expiredBookingHolds = await this.bookings.expireHolds(now);
          let sent = 0;
          let failed = 0;
          for (let i = 0; i < 20; i++) {
            const r = await this.notifications.dispatchPending(200);
            sent += r.sent;
            failed += r.failed;
            if (r.sent + r.failed === 0) break;
          }
          const keys = await this.prisma.idempotencyRecord.deleteMany({
            where: { expiresAt: { lt: now } },
          });
          const nonces = await this.prisma.authNonce.deleteMany({
            where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
          });
          const result: MaintenanceRunResult = {
            status: 'OK',
            runId: run.id,
            games,
            notifications: { sent, failed },
            expiredBookingHolds:
              typeof expiredBookingHolds === 'number' ? expiredBookingHolds : undefined,
            cleaned: { idempotencyKeys: keys.count, nonces: nonces.count },
          };
          await this.prisma.jobRun.update({
            where: { id: run.id },
            data: {
              status: 'OK',
              finishedAt: this.clock.now(),
              report: JSON.parse(JSON.stringify(result)),
            },
          });
          return result;
        } catch (e) {
          await this.prisma.jobRun.update({
            where: { id: run.id },
            data: {
              status: 'FAILED',
              finishedAt: this.clock.now(),
              error: e instanceof Error ? e.message.slice(0, 500) : 'error',
            },
          });
          throw e;
        }
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
  }

  recentRuns(limit = 20) {
    return this.prisma.jobRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }
}
