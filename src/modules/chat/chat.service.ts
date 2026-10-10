import { Injectable } from '@nestjs/common';
import type { Conversation, Message } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  type PageQuery,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import { ChatAccessService } from './chat-access.service';
import { ConversationDto, ConversationPageDto, MessageDto, MessagePageDto } from './dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChatAccessService,
    private readonly visibility: VisibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  // ───────────── opening / creating ─────────────

  /** Personal chat. Requires the recipient's message policy to allow the caller. */
  async openDirect(userId: string, targetId: string): Promise<ConversationDto> {
    if (userId === targetId)
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot message yourself');
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { status: true, privacy: true },
    });
    if (target?.status !== 'ACTIVE' || !target.privacy) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    const rel = await this.visibility.relationship(userId, targetId);
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey: directKey(userId, targetId) },
    });
    // An existing thread keeps working unless blocked; a NEW one must pass the recipient's policy.
    if (!existing && !this.visibility.canMessage(target.privacy, rel)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    return this.dtoFor(userId, await this.ensureDirect(this.prisma, userId, targetId));
  }

  /**
   * The special contact for players who cannot read the squad chat (pending, waitlisted, invited):
   * a direct thread with the organiser that does not depend on the organiser's general policy.
   */
  async contactOrganiser(userId: string, eventId: string): Promise<ConversationDto> {
    const ev = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { organiserId: true, status: true },
    });
    if (!ev || ev.status === 'DRAFT')
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    if (ev.organiserId === userId)
      throw new ApiError(ErrorCode.VALIDATION, 'You organise this game');
    const related =
      (await this.prisma.participation.count({ where: { eventId, userId } })) +
        (await this.prisma.invitation.count({ where: { eventId, inviteeId: userId } })) >
      0;
    if (!related)
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    if (await this.visibility.isBlockedEitherWay(userId, ev.organiserId)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    return this.dtoFor(userId, await this.ensureDirect(this.prisma, userId, ev.organiserId));
  }

  async eventConversation(userId: string, eventId: string): Promise<ConversationDto> {
    const conv = await this.prisma.$transaction((tx) => this.ensureScoped(tx, 'EVENT', eventId));
    return this.requireReadable(userId, conv);
  }

  async clubConversation(userId: string, clubId: string): Promise<ConversationDto> {
    const conv = await this.prisma.$transaction((tx) => this.ensureScoped(tx, 'CLUB', clubId));
    return this.requireReadable(userId, conv);
  }

  async tournamentConversation(userId: string, tournamentId: string): Promise<ConversationDto> {
    const conv = await this.prisma.$transaction((tx) =>
      this.ensureScoped(tx, 'TOURNAMENT', tournamentId),
    );
    return this.requireReadable(userId, conv);
  }

  private async requireReadable(userId: string, conv: Conversation): Promise<ConversationDto> {
    const rights = await this.access.rights(userId, conv);
    if (!rights.read) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    await this.prisma.$executeRaw`INSERT INTO "ConversationMember" ("conversationId", "userId")
      VALUES (${conv.id}::uuid, ${userId}::uuid) ON CONFLICT DO NOTHING`;
    return this.dtoFor(userId, conv);
  }

  /** get-or-create the game/club/tournament conversation under an advisory lock (no unique key exists). */
  async ensureScoped(
    tx: Tx,
    kind: 'EVENT' | 'CLUB' | 'TOURNAMENT',
    scopeId: string,
  ): Promise<Conversation> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conv:${kind}:${scopeId}`}))`;
    const where =
      kind === 'EVENT'
        ? { kind, eventId: scopeId }
        : kind === 'CLUB'
          ? { kind, clubId: scopeId }
          : { kind, tournamentId: scopeId };
    const existing = await tx.conversation.findFirst({ where });
    if (existing) return existing;
    const exists =
      kind === 'EVENT'
        ? await tx.event.count({ where: { id: scopeId } })
        : kind === 'CLUB'
          ? await tx.club.count({ where: { id: scopeId } })
          : await tx.tournament.count({ where: { id: scopeId } });
    if (!exists) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return tx.conversation.create({ data: where });
  }

  private async ensureDirect(db: Db, a: string, b: string): Promise<Conversation> {
    const key = directKey(a, b);
    await db.$executeRaw`INSERT INTO "Conversation" (id, kind, "directKey")
      VALUES (gen_random_uuid(), 'DIRECT', ${key}) ON CONFLICT ("directKey") DO NOTHING`;
    const conv = await db.conversation.findUniqueOrThrow({ where: { directKey: key } });
    for (const u of [a, b]) {
      await db.$executeRaw`INSERT INTO "ConversationMember" ("conversationId", "userId")
        VALUES (${conv.id}::uuid, ${u}::uuid) ON CONFLICT DO NOTHING`;
    }
    return conv;
  }

  // ───────────── reading ─────────────

  async list(userId: string, q: PageQuery): Promise<ConversationPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const cursorId = cursor?.id ?? null;
    const rows = await this.prisma.$queryRaw<{ id: string; last_id: string }[]>`
      SELECT c.id, lm.id AS last_id
      FROM "Conversation" c
      JOIN LATERAL (
        SELECT m.id FROM "Message" m
        WHERE m."conversationId" = c.id AND m."deletedAt" IS NULL
        ORDER BY m.id DESC LIMIT 1
      ) lm ON true
      WHERE (
        c.id IN (SELECT "conversationId" FROM "ConversationMember" WHERE "userId" = ${userId}::uuid AND "leftAt" IS NULL)
        OR (c.kind = 'EVENT' AND (
              EXISTS (SELECT 1 FROM "Participation" p WHERE p."eventId" = c."eventId" AND p."userId" = ${userId}::uuid AND p.status = 'CONFIRMED')
           OR EXISTS (SELECT 1 FROM "Event" e WHERE e.id = c."eventId" AND e."organiserId" = ${userId}::uuid)))
        OR (c.kind = 'CLUB' AND EXISTS (SELECT 1 FROM "Membership" ms WHERE ms."clubId" = c."clubId" AND ms."userId" = ${userId}::uuid AND ms.status = 'MEMBER'))
      )
      AND (${cursorId}::uuid IS NULL OR lm.id < ${cursorId}::uuid)
      ORDER BY lm.id DESC
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const convs = await this.prisma.conversation.findMany({
      where: { id: { in: page.map((r) => r.id) } },
    });
    const byId = new Map(convs.map((c) => [c.id, c]));
    const items: ConversationDto[] = [];
    for (const r of page) {
      const conv = byId.get(r.id);
      if (!conv) continue;
      const rights = await this.access.rights(userId, conv);
      if (!rights.read) continue; // stale membership row: silently absent
      items.push(await this.dtoFor(userId, conv, rights));
    }
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: '', id: last.last_id }) : null,
    };
  }

  async unreadTotal(userId: string): Promise<{ unread: number }> {
    const page = await this.list(userId, { limit: 100 });
    return { unread: page.items.reduce((s, c) => s + c.unreadCount, 0) };
  }

  async messages(userId: string, conversationId: string, q: PageQuery): Promise<MessagePageDto> {
    const conv = await this.mustConversation(conversationId);
    const rights = await this.access.rights(userId, conv);
    if (!rights.read) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.message.findMany({
      where: { conversationId, ...(cursor ? { id: { lt: cursor.id } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const people = await loadPersonSummaries(
      this.prisma,
      page.flatMap((m) => (m.senderId ? [m.senderId] : [])),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((m) => this.toMessage(m, people)),
      nextCursor: hasMore && last ? encodeCursor({ t: '', id: last.id }) : null,
    };
  }

  async markRead(userId: string, conversationId: string): Promise<void> {
    const conv = await this.mustConversation(conversationId);
    if (!(await this.access.rights(userId, conv)).read) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    const now = this.clock.now();
    await this.prisma
      .$executeRaw`INSERT INTO "ConversationMember" ("conversationId", "userId", "lastReadAt")
      VALUES (${conv.id}::uuid, ${userId}::uuid, ${now}) ON CONFLICT ("conversationId", "userId")
      DO UPDATE SET "lastReadAt" = ${now}`;
  }

  // ───────────── writing ─────────────

  async send(
    userId: string,
    conversationId: string,
    body: string,
    key: string | undefined,
  ): Promise<MessageDto> {
    const text = body.trim();
    if (!text) throw new ApiError(ErrorCode.VALIDATION, 'Message is empty', { field: 'body' });
    return this.idempotency.execute(
      { userId, scope: `chat.send:${conversationId}`, key, payload: { text } },
      async (tx) => {
        const conv = await tx.conversation.findUnique({ where: { id: conversationId } });
        if (!conv) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        const rights = await this.access.rights(userId, conv, tx);
        if (!rights.read) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        // Possessing the conversation id is not permission: posting is re-authorised right now.
        if (!rights.post)
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            kind: 'TEXT',
            body: text,
            createdAt: this.clock.now(),
          },
        });
        await tx.$executeRaw`INSERT INTO "ConversationMember" ("conversationId", "userId", "lastReadAt")
          VALUES (${conversationId}::uuid, ${userId}::uuid, ${msg.createdAt}) ON CONFLICT ("conversationId", "userId")
          DO UPDATE SET "lastReadAt" = ${msg.createdAt}`;
        if (conv.kind === 'DIRECT') {
          const other = (conv.directKey ?? '').split(':').find((i) => i !== userId);
          if (other) {
            await this.notifier.notify(tx, {
              recipientIds: [other],
              category: 'chat',
              activityKind: 'chat.message',
              title: 'New message', // never the message text
              objectType: 'Conversation',
              objectId: conv.id,
              actorId: userId,
              activity: false,
              dedupeKey: `chat:${msg.id}`,
            });
          }
        }
        const people = await loadPersonSummaries(tx, [userId]);
        return this.toMessage(msg, people);
      },
    );
  }

  async edit(userId: string, messageId: string, body: string): Promise<MessageDto> {
    const msg = await this.ownMessage(userId, messageId);
    const conv = await this.mustConversation(msg.conversationId);
    if (!(await this.access.rights(userId, conv)).post) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    const text = body.trim();
    if (!text) throw new ApiError(ErrorCode.VALIDATION, 'Message is empty', { field: 'body' });
    const updated = await this.prisma.message.update({
      where: { id: msg.id },
      data: { body: text, editedAt: this.clock.now() },
    });
    return this.toMessage(updated, await loadPersonSummaries(this.prisma, [userId]));
  }

  async remove(userId: string, messageId: string): Promise<void> {
    const msg = await this.ownMessage(userId, messageId);
    await this.prisma.message.update({
      where: { id: msg.id },
      data: { deletedAt: this.clock.now() },
    });
  }

  // ───────────── internals ─────────────

  private async ownMessage(userId: string, messageId: string): Promise<Message> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId || msg.deletedAt || msg.kind !== 'TEXT') {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    return msg;
  }

  private async mustConversation(id: string): Promise<Conversation> {
    const conv = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return conv;
  }

  private toMessage(
    m: Message,
    people: Map<string, import('../users/person-summary').PersonSummaryDto>,
  ): MessageDto {
    const deleted = m.deletedAt !== null;
    return {
      id: m.id,
      conversationId: m.conversationId,
      sender: m.senderId ? personOrUnknown(people, m.senderId) : null,
      kind: m.kind,
      body: deleted ? null : m.body,
      cardType: deleted ? null : m.cardType,
      cardPayload: deleted ? null : ((m.cardPayload as Record<string, unknown> | null) ?? null),
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      deleted,
    };
  }

  private async dtoFor(
    userId: string,
    conv: Conversation,
    rights?: { read: boolean; post: boolean },
  ): Promise<ConversationDto> {
    const r = rights ?? (await this.access.rights(userId, conv));
    const last = await this.prisma.message.findFirst({
      where: { conversationId: conv.id, deletedAt: null },
      orderBy: { id: 'desc' },
    });
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: conv.id, userId } },
      select: { lastReadAt: true },
    });
    const unread = await this.prisma.message.count({
      where: {
        conversationId: conv.id,
        deletedAt: null,
        OR: [{ senderId: null }, { senderId: { not: userId } }], // system cards have no sender
        ...(member?.lastReadAt ? { createdAt: { gt: member.lastReadAt } } : {}),
      },
    });
    let counterpartId: string | null = null;
    if (conv.kind === 'DIRECT')
      counterpartId = (conv.directKey ?? '').split(':').find((i) => i !== userId) ?? null;
    const people = await loadPersonSummaries(this.prisma, [
      ...(counterpartId ? [counterpartId] : []),
      ...(last?.senderId ? [last.senderId] : []),
    ]);
    return {
      id: conv.id,
      kind: conv.kind,
      eventId: conv.eventId,
      clubId: conv.clubId,
      tournamentId: conv.tournamentId,
      counterpart: counterpartId ? personOrUnknown(people, counterpartId) : null,
      lastMessage: last ? this.toMessage(last, people) : null,
      unreadCount: r.read ? unread : 0,
      capabilities: { canRead: r.read, canPost: r.post },
    };
  }
}

/** Stable key for the pair: sorted ids joined by ':' */
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
