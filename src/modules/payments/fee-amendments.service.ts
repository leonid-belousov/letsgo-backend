import { Injectable } from '@nestjs/common';
import type { FeeAmendment, FeeAmendmentStatus, PaymentObligation, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
  type CursorPage,
} from '../../common/pagination/cursor-page';
import { PolicyService, type PolicyTarget } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockEvent, lockObligation, type Db, type Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  FeeAmendmentDto,
  type FeeAmendmentCapabilitiesDto,
  type ListFeeAmendmentsQuery,
  type ProposeFeeAmendmentDto,
  type ProposeFeeAmendmentResultDto,
  type RespondFeeAmendmentDto,
} from './fee-amendments.dto';
import { PaymentsService } from './payments.service';

const NOT_AVAILABLE = 'This content isn’t available';
const DENIED = 'You no longer have access to this action.';
const REFUND_REASON = 'Fee reduced by accepted amendment';

/**
 * A later change of a game's fee (Handoff §16 / Decisions §17):
 *  - the game price changes immediately (so people who join afterwards agree to the new price);
 *  - every already confirmed payer gets a PENDING amendment and must accept it;
 *  - the obligation changes only on that player's acceptance; receipts are never rewritten and
 *    an excess becomes the documented "Refund due" state (no money is considered moved);
 *  - waitlisted / pending players have no obligation and are not touched.
 * All state changes serialise on the Event row (proposal) or the Obligation row (responses), the
 * same lock cash confirmation uses, so a racing Cash received stays consistent.
 */
@Injectable()
export class FeeAmendmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly payments: PaymentsService,
  ) {}

  // ───────────── organiser side ─────────────

  async propose(
    actorId: string,
    eventId: string,
    dto: ProposeFeeAmendmentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<ProposeFeeAmendmentResultDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `payments.feeAmendment.propose:${eventId}`,
        key,
        payload: { newPriceMinor: dto.newPriceMinor, reason: dto.reason ?? null },
      },
      async (tx) => {
        const exists = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
        if (!exists) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        await this.policy.assert(actorId, 'event.fees.change', this.eventTarget(eventId), tx);
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if ((ev.status !== 'PUBLISHED' && ev.status !== 'STARTED') || ev.cancelledAt) {
          throw new ApiError(ErrorCode.CONFLICT, 'The fee of this game can no longer be changed', {
            status: ev.status,
          });
        }
        const newPrice = dto.newPriceMinor;

        // Serialise with Cash received / responses: lock every live fee obligation in id order.
        const live = await tx.paymentObligation.findMany({
          where: { eventId, kind: 'EVENT_FEE', status: { not: 'CANCELLED' } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        for (const o of live) await lockObligation(tx, o.id);

        if (ev.priceMinor !== newPrice) {
          await tx.event.update({
            where: { id: eventId },
            data: { priceMinor: newPrice, version: { increment: 1 } },
          });
          await this.audit.record(tx, {
            actorId,
            action: 'payment.event_price_changed',
            targetType: 'Event',
            targetId: eventId,
            requestId,
            metadata: { oldPriceMinor: ev.priceMinor, newPriceMinor: newPrice },
          });
        }

        const confirmed = await tx.participation.findMany({
          where: { eventId, status: 'CONFIRMED' },
          select: { userId: true },
        });
        const obligations = await tx.paymentObligation.findMany({
          where: {
            eventId,
            kind: 'EVENT_FEE',
            status: { not: 'CANCELLED' },
            payerUserId: { in: confirmed.map((p) => p.userId) },
          },
          orderBy: { id: 'asc' },
        });
        const pendings = await tx.feeAmendment.findMany({ where: { eventId, status: 'PENDING' } });

        // A pending proposal for exactly this amount stays as it is (retry = no re-notification).
        const keep = new Map<string, FeeAmendment>();
        const supersedeIds: string[] = [];
        for (const a of pendings) {
          const ob = obligations.find((o) => o.id === a.obligationId);
          if (ob && ob.amountMinor !== newPrice && a.newAmountMinor === newPrice) {
            keep.set(a.obligationId, a);
          } else {
            supersedeIds.push(a.id);
          }
        }
        // Supersede first so the one-PENDING-per-obligation unique index is never violated.
        if (supersedeIds.length > 0) {
          await tx.feeAmendment.updateMany({
            where: { id: { in: supersedeIds }, status: 'PENDING' },
            data: { status: 'SUPERSEDED', version: { increment: 1 } },
          });
        }

        const canCancel = await this.policy.can(
          actorId,
          'event.fees.change',
          this.eventTarget(eventId),
          tx,
        );
        const rows: FeeAmendment[] = [];
        for (const ob of obligations) {
          if (ob.amountMinor === newPrice || !ob.payerUserId) continue;
          const kept = keep.get(ob.id);
          if (kept) {
            rows.push(kept);
            continue;
          }
          const created = await tx.feeAmendment.create({
            data: {
              eventId,
              obligationId: ob.id,
              participantId: ob.payerUserId,
              oldAmountMinor: ob.amountMinor,
              newAmountMinor: newPrice,
              currency: ob.currency,
              reason: dto.reason ?? null,
              proposedById: actorId,
            },
          });
          rows.push(created);
          await this.notifier.notify(tx, {
            recipientIds: [ob.payerUserId],
            category: 'cash',
            activityKind: 'fee.amendment_proposed',
            title: 'The fee for a game was changed — please review',
            objectType: 'FeeAmendment',
            objectId: created.id,
            actorId,
            essential: true,
            payload: {
              amendmentId: created.id,
              eventId,
              oldAmountMinor: ob.amountMinor,
              newAmountMinor: newPrice,
              currency: ob.currency,
            },
            dedupeKey: `fee-amendment:${created.id}:proposed`,
            chatCard: { type: 'FEE_AMENDMENT', payload: { amendmentId: created.id, eventId } },
          });
          await this.audit.record(tx, {
            actorId,
            action: 'payment.fee_amendment_proposed',
            targetType: 'FeeAmendment',
            targetId: created.id,
            requestId,
            metadata: {
              eventId,
              obligationId: ob.id,
              oldAmountMinor: ob.amountMinor,
              newAmountMinor: newPrice,
            },
          });
        }

        const cap: FeeAmendmentCapabilitiesDto = {
          canAccept: false,
          canReject: false,
          canCancel,
        };
        return {
          eventId,
          priceMinor: newPrice,
          proposed: rows.length,
          amendments: rows.map((r) => FeeAmendmentDto.from(r, cap)),
        };
      },
    );
  }

  async listForEvent(
    viewerId: string,
    eventId: string,
    query: ListFeeAmendmentsQuery,
  ): Promise<CursorPage<FeeAmendmentDto>> {
    const target = this.eventTarget(eventId);
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    if (!event) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const allowed =
      (await this.policy.can(viewerId, 'event.money.view', target)) ||
      (await this.policy.can(viewerId, 'event.cash.confirm', target)) ||
      (await this.policy.can(viewerId, 'event.fees.change', target));
    if (!allowed) throw new ApiError(ErrorCode.ACCESS_DENIED, DENIED);

    const limit = clampPageSize(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.feeAmendment.findMany({
      where: {
        eventId,
        ...(query.status ? { status: query.status } : {}),
        ...keysetBefore('createdAt', cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const canCancel = await this.policy.can(viewerId, 'event.fees.change', target);
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: page.items.map((r) =>
        FeeAmendmentDto.from(r, this.capabilities(viewerId, r.status, r.participantId, canCancel)),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** A cancelled proposal by a fee-changer; the game price is not reverted. */
  async cancel(
    actorId: string,
    amendmentId: string,
    key: string | undefined,
    requestId?: string,
  ): Promise<FeeAmendmentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `payments.feeAmendment.cancel:${amendmentId}`, key, payload: {} },
      async (tx) => {
        const first = await this.loadFor(tx, amendmentId, actorId);
        await lockObligation(tx, first.obligationId);
        const am = await this.reload(tx, amendmentId);
        const canCancel = await this.policy.can(
          actorId,
          'event.fees.change',
          this.eventTarget(am.eventId),
          tx,
        );
        if (!canCancel) {
          // The participant may see their own amendment but not withdraw it.
          throw new ApiError(
            am.participantId === actorId ? ErrorCode.ACCESS_DENIED : ErrorCode.NOT_FOUND,
            am.participantId === actorId ? DENIED : NOT_AVAILABLE,
          );
        }
        if (am.status === 'CANCELLED') return this.result(tx, actorId, am, canCancel);
        if (am.status !== 'PENDING') {
          throw new ApiError(ErrorCode.CONFLICT, 'This fee change is no longer pending', {
            status: am.status,
          });
        }
        const updated = await tx.feeAmendment.update({
          where: { id: am.id },
          data: {
            status: 'CANCELLED',
            respondedById: actorId,
            respondedAt: this.clock.now(),
            version: { increment: 1 },
          },
        });
        await this.notifier.notify(tx, {
          recipientIds: [am.participantId],
          category: 'cash',
          activityKind: 'fee.amendment_cancelled',
          title: 'A proposed fee change was withdrawn',
          objectType: 'FeeAmendment',
          objectId: am.id,
          actorId,
          essential: true,
          payload: { amendmentId: am.id, eventId: am.eventId },
          dedupeKey: `fee-amendment:${am.id}:cancelled`,
        });
        await this.audit.record(tx, {
          actorId,
          action: 'payment.fee_amendment_cancelled',
          targetType: 'FeeAmendment',
          targetId: am.id,
          requestId,
          metadata: { eventId: am.eventId, obligationId: am.obligationId },
        });
        return this.result(tx, actorId, updated, canCancel);
      },
    );
  }

  // ───────────── participant side ─────────────

  /** My amendments: pending first, then the most recent decided ones. */
  async listMine(userId: string): Promise<FeeAmendmentDto[]> {
    const [pending, decided] = await Promise.all([
      this.prisma.feeAmendment.findMany({
        where: { participantId: userId, status: 'PENDING' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
      this.prisma.feeAmendment.findMany({
        where: { participantId: userId, status: { not: 'PENDING' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);
    const rows = [...pending, ...decided];
    const cancelCache = new Map<string, boolean>();
    const out: FeeAmendmentDto[] = [];
    for (const r of rows) {
      let canCancel = cancelCache.get(r.eventId);
      if (canCancel === undefined) {
        canCancel = await this.policy.can(userId, 'event.fees.change', this.eventTarget(r.eventId));
        cancelCache.set(r.eventId, canCancel);
      }
      out.push(
        FeeAmendmentDto.from(r, this.capabilities(userId, r.status, r.participantId, canCancel)),
      );
    }
    return out;
  }

  async accept(
    actorId: string,
    amendmentId: string,
    dto: RespondFeeAmendmentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<FeeAmendmentDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `payments.feeAmendment.accept:${amendmentId}`,
        key,
        payload: { version: dto.version },
      },
      async (tx) => {
        const first = await this.loadFor(tx, amendmentId, actorId, true);
        await lockObligation(tx, first.obligationId);
        const am = await this.reload(tx, amendmentId);
        if (am.status === 'ACCEPTED') return this.result(tx, actorId, am, false);
        this.assertPending(am, dto.version);

        const ob = await tx.paymentObligation.findUnique({ where: { id: am.obligationId } });
        if (!ob || ob.status === 'CANCELLED') {
          throw new ApiError(ErrorCode.CONFLICT, 'This fee is no longer owed', {
            status: ob?.status ?? null,
          });
        }
        await this.assertStillConfirmed(tx, am);

        // Receipts are never touched. Anything already received beyond the new amount is shown
        // as "Refund due" (explicitly, not hidden credit); no money is considered moved.
        const paid = ob.paidMinor;
        const excess = Math.max(0, paid - am.newAmountMinor - ob.refundDueMinor - ob.refundedMinor);
        if (excess > 0) {
          await tx.adjustment.create({
            data: {
              obligationId: ob.id,
              type: 'REFUND_DUE',
              deltaMinor: excess,
              reason: REFUND_REASON,
              actorId: am.proposedById,
            },
          });
        }
        const updatedOb = await tx.paymentObligation.update({
          where: { id: ob.id },
          data: {
            amountMinor: am.newAmountMinor,
            status: this.payments.statusFor(am.newAmountMinor, paid),
            ...(excess > 0 ? { refundDueMinor: { increment: excess } } : {}),
            version: { increment: 1 },
          },
        });
        const updated = await tx.feeAmendment.update({
          where: { id: am.id },
          data: {
            status: 'ACCEPTED',
            respondedById: actorId,
            respondedAt: this.clock.now(),
            version: { increment: 1 },
          },
        });
        await this.notifier.notify(tx, {
          recipientIds: [am.proposedById],
          category: 'cash',
          activityKind: 'fee.amendment_accepted',
          title: 'A player accepted the new fee',
          objectType: 'FeeAmendment',
          objectId: am.id,
          actorId,
          essential: true,
          payload: this.responsePayload(am),
          dedupeKey: `fee-amendment:${am.id}:accepted`,
        });
        await this.audit.record(tx, {
          actorId,
          action: 'payment.fee_amendment_accepted',
          targetType: 'FeeAmendment',
          targetId: am.id,
          requestId,
          metadata: {
            eventId: am.eventId,
            obligationId: am.obligationId,
            oldAmountMinor: ob.amountMinor,
            newAmountMinor: am.newAmountMinor,
            refundDueAddedMinor: excess,
            resultingStatus: updatedOb.status,
          },
        });
        return this.result(tx, actorId, updated, false, updatedOb);
      },
    );
  }

  async reject(
    actorId: string,
    amendmentId: string,
    dto: RespondFeeAmendmentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<FeeAmendmentDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `payments.feeAmendment.reject:${amendmentId}`,
        key,
        payload: { version: dto.version },
      },
      async (tx) => {
        const first = await this.loadFor(tx, amendmentId, actorId, true);
        await lockObligation(tx, first.obligationId);
        const am = await this.reload(tx, amendmentId);
        if (am.status === 'REJECTED') return this.result(tx, actorId, am, false);
        this.assertPending(am, dto.version);

        // The obligation is deliberately left as it is. What happens to a player who refuses the
        // new terms (stay at the old fee? leave?) is an OPEN product decision: nothing automatic.
        const updated = await tx.feeAmendment.update({
          where: { id: am.id },
          data: {
            status: 'REJECTED',
            respondedById: actorId,
            respondedAt: this.clock.now(),
            version: { increment: 1 },
          },
        });
        await this.notifier.notify(tx, {
          recipientIds: [am.proposedById],
          category: 'cash',
          activityKind: 'fee.amendment_rejected',
          title: 'A player did not accept the new fee',
          objectType: 'FeeAmendment',
          objectId: am.id,
          actorId,
          essential: true,
          payload: this.responsePayload(am),
          dedupeKey: `fee-amendment:${am.id}:rejected`,
        });
        await this.audit.record(tx, {
          actorId,
          action: 'payment.fee_amendment_rejected',
          targetType: 'FeeAmendment',
          targetId: am.id,
          requestId,
          metadata: { eventId: am.eventId, obligationId: am.obligationId },
        });
        return this.result(tx, actorId, updated, false);
      },
    );
  }

  // ───────────── helpers ─────────────

  private eventTarget(eventId: string): PolicyTarget {
    return { type: 'EVENT', id: eventId };
  }

  private capabilities(
    viewerId: string,
    status: FeeAmendmentStatus,
    participantId: string,
    canCancel: boolean,
  ): FeeAmendmentCapabilitiesDto {
    const pending = status === 'PENDING';
    const mine = participantId === viewerId;
    return {
      canAccept: pending && mine,
      canReject: pending && mine,
      canCancel: pending && canCancel,
    };
  }

  /**
   * Loads an amendment the viewer may know about: its participant, or (unless `participantOnly`)
   * someone who may change the game's fees. Anyone else gets NOT_FOUND (no existence leak).
   */
  private async loadFor(
    tx: Tx,
    amendmentId: string,
    viewerId: string,
    participantOnly = false,
  ): Promise<FeeAmendment> {
    const am = await tx.feeAmendment.findUnique({ where: { id: amendmentId } });
    if (!am) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    if (am.participantId === viewerId) return am;
    if (
      !participantOnly &&
      (await this.policy.can(viewerId, 'event.fees.change', this.eventTarget(am.eventId), tx))
    ) {
      return am;
    }
    throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
  }

  /** Re-read under the obligation lock: the state another request just committed. */
  private async reload(tx: Tx, amendmentId: string): Promise<FeeAmendment> {
    return tx.feeAmendment.findUniqueOrThrow({ where: { id: amendmentId } });
  }

  private assertPending(am: FeeAmendment, version: number): void {
    if (am.status !== 'PENDING') {
      throw new ApiError(ErrorCode.CONFLICT, 'This fee change is no longer pending', {
        status: am.status,
      });
    }
    if (am.version !== version) {
      throw new ApiError(ErrorCode.VERSION_CHANGED, 'This fee change was updated', {
        currentVersion: am.version,
      });
    }
  }

  private async assertStillConfirmed(tx: Tx, am: FeeAmendment): Promise<void> {
    const p = await tx.participation.findUnique({
      where: { eventId_userId: { eventId: am.eventId, userId: am.participantId } },
      select: { status: true },
    });
    if (p?.status !== 'CONFIRMED') {
      throw new ApiError(ErrorCode.CONFLICT, 'You no longer have a confirmed place in this game');
    }
  }

  private responsePayload(am: FeeAmendment): Prisma.InputJsonObject {
    return {
      amendmentId: am.id,
      eventId: am.eventId,
      oldAmountMinor: am.oldAmountMinor,
      newAmountMinor: am.newAmountMinor,
      currency: am.currency,
    };
  }

  private async result(
    db: Db,
    viewerId: string,
    am: FeeAmendment,
    canCancel: boolean,
    obligation?: PaymentObligation,
  ): Promise<FeeAmendmentDto> {
    const dto = FeeAmendmentDto.from(
      am,
      this.capabilities(viewerId, am.status, am.participantId, canCancel),
    );
    const ob =
      obligation ?? (await db.paymentObligation.findUnique({ where: { id: am.obligationId } }));
    if (ob) dto.obligation = await this.payments.obligationView(viewerId, ob, db);
    return dto;
  }
}
