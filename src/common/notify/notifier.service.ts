import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { Db } from '../transactions/tx';

export interface NotifyInput {
  /** Recipients (deduplicated internally). The caller excludes the actor when appropriate. */
  recipientIds: string[];
  /** Coarse preference bucket, e.g. 'invitation' | 'booking' | 'cash' | 'social' | 'club' | 'tournament' | 'result' | 'system'. */
  category: string;
  /** Activity feed kind, e.g. 'invitation.received'. */
  activityKind: string;
  title: string;
  body?: string;
  objectType: string;
  objectId: string;
  actorId?: string | null;
  /** Display data only — NEVER private post/event content the recipient may not see. */
  payload?: Prisma.InputJsonObject;
  /**
   * Stable key making the notification idempotent per recipient
   * (e.g. `invitation:<id>:received`). Omit only for genuinely repeatable notices.
   */
  dedupeKey?: string;
  /**
   * Operational notices about an object the recipient participates in must still arrive
   * between blocked users (Decisions §8). Default false = social notices are dropped when blocked.
   */
  essential?: boolean;
  /** Default true. Chat-message pings pass false: the Activity feed is for social/operational events only. */
  activity?: boolean;
  /**
   * Also drop an actionable card (invitation, cash request, …) into each recipient's personal
   * system conversation. The card only carries ids/display data; the client must call the API
   * (which re-checks access) to act on it.
   */
  chatCard?: { type: string; payload: Prisma.InputJsonObject };
}

/**
 * The single side-effect path of the domain (TECH decision: no message broker). Writing the
 * ActivityItem and Notification rows *inside the caller's transaction* guarantees they exist
 * iff the state change committed. External push delivery is asynchronous and reads
 * `Notification.delivery = PENDING` rows (see NotificationDispatcher).
 */
@Injectable()
export class Notifier {
  constructor(private readonly prisma: PrismaService) {}

  async notify(db: Db | undefined, input: NotifyInput): Promise<void> {
    const client = db ?? this.prisma;
    let recipients = [...new Set(input.recipientIds)].filter((id) => id !== input.actorId);
    if (recipients.length === 0) return;

    if (input.actorId && !input.essential) {
      const blocks = await client.block.findMany({
        where: {
          OR: [
            { blockerId: input.actorId, blockedId: { in: recipients } },
            { blockedId: input.actorId, blockerId: { in: recipients } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      });
      const blocked = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]));
      recipients = recipients.filter((r) => !blocked.has(r));
      if (recipients.length === 0) return;
    }

    if (input.activity !== false) {
      await client.activityItem.createMany({
        data: recipients.map((recipientId) => ({
          recipientId,
          kind: input.activityKind,
          actorId: input.actorId ?? null,
          objectType: input.objectType,
          objectId: input.objectId,
          payload: input.payload ?? undefined,
          dedupeKey: input.dedupeKey ?? null,
        })),
        skipDuplicates: true,
      });
    }
    if (input.chatCard) {
      for (const recipientId of recipients) {
        // Race-free get-or-create of the recipient's personal system conversation.
        const directKey = `system:${recipientId}`;
        await client.$executeRaw`INSERT INTO "Conversation" (id, kind, "directKey")
          VALUES (gen_random_uuid(), 'SYSTEM', ${directKey}) ON CONFLICT ("directKey") DO NOTHING`;
        const conv = await client.conversation.findUniqueOrThrow({ where: { directKey } });
        await client.$executeRaw`INSERT INTO "ConversationMember" ("conversationId", "userId")
          VALUES (${conv.id}::uuid, ${recipientId}::uuid) ON CONFLICT DO NOTHING`;
        await client.message.create({
          data: {
            conversationId: conv.id,
            senderId: null,
            kind: 'SYSTEM_CARD',
            cardType: input.chatCard.type,
            cardPayload: {
              ...input.chatCard.payload,
              objectType: input.objectType,
              objectId: input.objectId,
            },
          },
        });
      }
    }

    const prefs = await client.notificationPreference.findMany({
      where: { userId: { in: recipients }, category: input.category },
    });
    const prefBy = new Map(prefs.map((p) => [p.userId, p]));
    const rows = recipients
      .map((recipientId) => {
        const pref = prefBy.get(recipientId);
        const inApp = pref?.inApp ?? true;
        const push = pref?.push ?? true;
        if (!inApp && !push) return null;
        return {
          recipientId,
          category: input.category,
          title: input.title,
          body: input.body ?? null,
          objectType: input.objectType,
          objectId: input.objectId,
          dedupeKey: input.dedupeKey ?? null,
          delivery: push ? ('PENDING' as const) : ('SKIPPED' as const),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      await client.notification.createMany({ data: rows, skipDuplicates: true });
    }
  }
}

@Global()
@Module({ providers: [Notifier], exports: [Notifier] })
export class NotifyModule {}
