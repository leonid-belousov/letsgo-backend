import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn } from 'class-validator';
import type { Notification } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  PageQuery,
  toPage,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Preference buckets used by Notifier callers. */
export const NOTIFICATION_CATEGORIES = [
  'game',
  'invitation',
  'cash',
  'booking',
  'club',
  'tournament',
  'result',
  'social',
  'chat',
  'system',
] as const;

export class NotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ description: 'Neutral text; never private post/event content' }) title!: string;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({ nullable: true, type: String }) objectType!: string | null;
  @ApiProperty({ nullable: true, type: String }) objectId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) readAt!: string | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] }) items!: NotificationDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class PreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES }) category!: string;
  @ApiProperty() inApp!: boolean;
  @ApiProperty() push!: boolean;
}

export class UpdatePreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  @IsIn(NOTIFICATION_CATEGORIES as unknown as string[])
  category!: string;
  @ApiProperty() @IsBoolean() inApp!: boolean;
  @ApiProperty() @IsBoolean() push!: boolean;
}

/**
 * Push/e-mail provider seam (provider choice is OPEN #9). Implementations must treat the
 * notification as opaque display text — it is already privacy-neutral.
 */
export abstract class NotificationDeliveryProvider {
  abstract deliver(
    n: Pick<Notification, 'id' | 'recipientId' | 'category' | 'title'>,
  ): Promise<void>;
}

/** Development provider: logs only ids and category — never titles/bodies of private objects. */
@Injectable()
export class LogDeliveryProvider extends NotificationDeliveryProvider {
  private readonly log = new Logger('NotificationDelivery');
  deliver(n: Pick<Notification, 'id' | 'recipientId' | 'category' | 'title'>): Promise<void> {
    this.log.debug(`deliver notification=${n.id} category=${n.category}`);
    return Promise.resolve();
  }
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: NotificationDeliveryProvider,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(userId: string, q: PageQuery): Promise<NotificationPageDto> {
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId, ...keysetBefore('createdAt', decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return { items: page.items.map((n) => this.dto(n)), nextCursor: page.nextCursor };
  }

  async unreadCount(userId: string) {
    return {
      unread: await this.prisma.notification.count({
        where: { recipientId: userId, readAt: null },
      }),
    };
  }

  async markRead(userId: string, ids: string[]) {
    const res = await this.prisma.notification.updateMany({
      where: { recipientId: userId, id: { in: ids }, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: res.count };
  }

  async preferences(userId: string): Promise<PreferenceDto[]> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const by = new Map(rows.map((r) => [r.category, r]));
    // Defaults are ON; social updates do not push per post (they land in Following/Activity only).
    return NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      inApp: by.get(category)?.inApp ?? true,
      push: by.get(category)?.push ?? category !== 'social',
    }));
  }

  async setPreference(userId: string, dto: UpdatePreferenceDto): Promise<PreferenceDto> {
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(dto.category)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown category', { field: 'category' });
    }
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId_category: { userId, category: dto.category } },
      create: { userId, category: dto.category, inApp: dto.inApp, push: dto.push },
      update: { inApp: dto.inApp, push: dto.push },
    });
    return { category: row.category, inApp: row.inApp, push: row.push };
  }

  /**
   * Sends due notifications through the provider (PENDING, or FAILED whose retry time has come).
   * `FOR UPDATE SKIP LOCKED` lets several instances share the queue without duplicates. A provider
   * failure NEVER loses the in-app notification: the row stays readable, the attempt is counted, the
   * error is stored provider-neutrally (class name only, no payload) and the next attempt is
   * scheduled with exponential backoff until NOTIFICATION_MAX_ATTEMPTS, then it stays FAILED.
   */
  async dispatchPending(limit = 50): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const now = this.clock.now();
    const maxAttempts = this.config.get('NOTIFICATION_MAX_ATTEMPTS', { infer: true });
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Pick<Notification, 'id' | 'recipientId' | 'category' | 'title' | 'attempts'>[]
      >`
        SELECT id, "recipientId", category, title, attempts FROM "Notification"
        WHERE delivery = 'PENDING'
           OR (delivery = 'FAILED' AND attempts < ${maxAttempts} AND "nextAttemptAt" <= ${now})
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const n of rows) {
        try {
          await this.provider.deliver(n);
          await tx.notification.update({
            where: { id: n.id },
            data: {
              delivery: 'SENT',
              deliveredAt: now,
              attempts: n.attempts + 1,
              lastError: null,
              nextAttemptAt: null,
            },
          });
          sent += 1;
        } catch (e) {
          const attempts = n.attempts + 1;
          const backoffMinutes = Math.min(60, 2 ** attempts);
          await tx.notification.update({
            where: { id: n.id },
            data: {
              delivery: 'FAILED',
              attempts,
              lastError: e instanceof Error ? e.name.slice(0, 80) : 'DeliveryError',
              nextAttemptAt:
                attempts < maxAttempts ? new Date(now.getTime() + backoffMinutes * 60_000) : null,
            },
          });
          failed += 1;
        }
      }
    });
    return { sent, failed };
  }

  private dto(n: Notification): NotificationDto {
    return {
      id: n.id,
      category: n.category,
      title: n.title,
      body: n.body,
      objectType: n.objectType,
      objectId: n.objectId,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    };
  }
}
