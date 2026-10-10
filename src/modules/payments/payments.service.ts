import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentObligation, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import type { PermissionName } from '../../common/permissions/permissions';
import { PolicyService, type PolicyTarget } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockObligation, type Db, type Tx } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AdjustmentDto,
  CashReceiptDto,
  ObligationCapabilitiesDto,
  ObligationDto,
  type CashReceivedDto,
  type CreateAdjustmentDto,
  type EventMoneySummaryDto,
} from './dto';

interface ReceiverScope {
  confirm: { permission: PermissionName; target: PolicyTarget };
  correct: { permission: PermissionName; target: PolicyTarget };
  view: { permission: PermissionName; target: PolicyTarget };
}

/**
 * Cash-only obligations (no gateway, no wallet, no bank transfer — DOC).
 *  - "Pay cash" records the payer's intent and notifies receivers; it never marks anything paid.
 *  - Only an authorised receiver (never the payer) records "Cash received"; receipts and
 *    adjustments are immutable rows (DB triggers) and every state change is idempotent.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ───────────── used by other modules (inside their transactions) ─────────────

  /** Creates (or reopens) the player's fee for a confirmed place. No fee → no obligation. */
  async ensureEventFeeObligation(
    tx: Tx,
    event: { id: string; priceMinor: number; currency: string },
    userId: string,
  ): Promise<void> {
    if (event.priceMinor <= 0) return;
    const key = { kind: 'EVENT_FEE' as const, eventId: event.id, payerUserId: userId };
    const existing = await tx.paymentObligation.findUnique({
      where: { kind_eventId_payerUserId: key },
    });
    if (!existing) {
      await tx.paymentObligation.create({
        data: { ...key, amountMinor: event.priceMinor, currency: event.currency },
      });
      return;
    }
    if (existing.status === 'CANCELLED') {
      // A returning player who paid nothing agrees to the price valid now (it may have been amended).
      const amount = existing.paidMinor === 0 ? event.priceMinor : existing.amountMinor;
      await tx.paymentObligation.update({
        where: { id: existing.id },
        data: {
          amountMinor: amount,
          currency: existing.paidMinor === 0 ? event.currency : existing.currency,
          status: this.statusFor(amount, existing.paidMinor),
          version: { increment: 1 },
        },
      });
    }
  }

  /**
   * Tournament fee obligation (club fee or player fee). Idempotent: returns the existing row.
   * No fee (amount 0) → no obligation. Caller runs inside its own transaction.
   */
  async ensureTournamentObligation(
    tx: Tx,
    input: {
      kind: 'TOURNAMENT_CLUB_FEE' | 'TOURNAMENT_PLAYER_FEE';
      tournamentId: string;
      payerClubId?: string;
      payerUserId?: string;
      amountMinor: number;
      currency: string;
    },
  ): Promise<PaymentObligation | null> {
    if (input.amountMinor <= 0) return null;
    if (input.kind === 'TOURNAMENT_CLUB_FEE' ? !input.payerClubId : !input.payerUserId) {
      throw new ApiError(ErrorCode.VALIDATION, 'Missing payer for tournament fee');
    }
    const where =
      input.kind === 'TOURNAMENT_CLUB_FEE'
        ? { kind: input.kind, tournamentId: input.tournamentId, payerClubId: input.payerClubId }
        : { kind: input.kind, tournamentId: input.tournamentId, payerUserId: input.payerUserId };
    const existing = await tx.paymentObligation.findFirst({ where });
    if (existing) {
      if (existing.status === 'CANCELLED') {
        return tx.paymentObligation.update({
          where: { id: existing.id },
          data: {
            status: this.statusFor(existing.amountMinor, existing.paidMinor),
            version: { increment: 1 },
          },
        });
      }
      return existing;
    }
    return tx.paymentObligation.create({
      data: {
        kind: input.kind,
        tournamentId: input.tournamentId,
        payerClubId: input.payerClubId ?? null,
        payerUserId: input.payerUserId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
    });
  }

  /** Cancel an unpaid tournament obligation (withdrawn entry / removed player). Paid ones stay for staff to handle. */
  async cancelUnpaidTournamentObligation(
    tx: Tx,
    where: { tournamentId: string; payerClubId?: string; payerUserId?: string },
  ): Promise<void> {
    await tx.paymentObligation.updateMany({
      where: { ...where, paidMinor: 0, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
  }

  /** Player left / was removed before paying: the unpaid obligation disappears (no debt). */
  async cancelPlayerObligation(tx: Tx, eventId: string, userId: string): Promise<void> {
    await tx.paymentObligation.updateMany({
      where: {
        kind: 'EVENT_FEE',
        eventId,
        payerUserId: userId,
        paidMinor: 0,
        status: { not: 'CANCELLED' },
      },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    // The player left: a proposed fee change for them has no addressee any more.
    await tx.feeAmendment.updateMany({
      where: { eventId, participantId: userId, status: 'PENDING' },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
  }

  /** Event cancelled: unpaid obligations vanish; anything already paid becomes "Refund due" (not "Refunded"). */
  async cancelObligationsForEvent(
    tx: Tx,
    eventId: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    await tx.feeAmendment.updateMany({
      where: { eventId, status: 'PENDING' },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    await tx.paymentObligation.updateMany({
      where: { eventId, paidMinor: 0, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    const paid = await tx.paymentObligation.findMany({
      where: { eventId, paidMinor: { gt: 0 }, status: { not: 'CANCELLED' } },
    });
    for (const ob of paid) {
      await lockObligation(tx, ob.id);
      const due = ob.paidMinor - ob.refundDueMinor - ob.refundedMinor;
      if (due > 0) {
        await tx.adjustment.create({
          data: { obligationId: ob.id, type: 'REFUND_DUE', deltaMinor: due, reason, actorId },
        });
      }
      await tx.paymentObligation.update({
        where: { id: ob.id },
        data: {
          status: 'CANCELLED',
          refundDueMinor: { increment: Math.max(due, 0) },
          version: { increment: 1 },
        },
      });
    }
  }

  // ───────────── payer side ─────────────

  async listMine(userId: string, status?: PaymentObligation['status']): Promise<ObligationDto[]> {
    const rows = await this.prisma.paymentObligation.findMany({
      where: { payerUserId: userId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return Promise.all(rows.map((o) => this.toDto(userId, o, this.prisma)));
  }

  async get(viewerId: string, obligationId: string): Promise<ObligationDto> {
    const ob = await this.loadVisible(viewerId, obligationId, this.prisma);
    const dto = await this.toDto(viewerId, ob, this.prisma);
    const [receipts, adjustments] = await Promise.all([
      this.prisma.cashReceipt.findMany({ where: { obligationId }, orderBy: { receivedAt: 'asc' } }),
      this.prisma.adjustment.findMany({ where: { obligationId }, orderBy: { createdAt: 'asc' } }),
    ]);
    dto.receipts = receipts.map(CashReceiptDto.from);
    dto.adjustments = adjustments.map(AdjustmentDto.from);
    return dto;
  }

  /**
   * "Pay cash": payer says they will pay in cash. Idempotent. Does NOT change the amount,
   * status or participation — payment stays unpaid until a receiver records Cash received.
   */
  async payCash(payerId: string, obligationId: string, requestId?: string): Promise<ObligationDto> {
    return this.prisma.$transaction(async (tx) => {
      const ob = await tx.paymentObligation.findUnique({ where: { id: obligationId } });
      if (!ob || ob.payerUserId !== payerId)
        throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      if (ob.status === 'PAID' || ob.status === 'CANCELLED') {
        throw new ApiError(ErrorCode.CONFLICT, 'Nothing left to pay', { status: ob.status });
      }
      if (ob.eventId) {
        const ev = await tx.event.findUnique({
          where: { id: ob.eventId },
          select: { payCashEnabled: true },
        });
        if (!ev?.payCashEnabled)
          throw new ApiError(ErrorCode.CONFLICT, 'Pay cash is not enabled for this game');
      }
      let current = ob;
      if (!ob.payCashRequestedAt) {
        current = await tx.paymentObligation.update({
          where: { id: ob.id },
          data: { payCashRequestedAt: this.clock.now(), version: { increment: 1 } },
        });
        const receivers = await this.eligibleReceiverIds(tx, ob);
        await this.notifier.notify(tx, {
          recipientIds: receivers,
          category: 'cash',
          activityKind: 'cash.pay_cash_requested',
          title: 'A player chose Pay cash',
          objectType: 'PaymentObligation',
          objectId: ob.id,
          actorId: payerId,
          essential: true,
          payload: { eventId: ob.eventId, amountMinor: ob.amountMinor, currency: ob.currency },
          dedupeKey: `cash:${ob.id}:pay_cash_requested`,
          chatCard: { type: 'CASH_REQUEST', payload: { obligationId: ob.id, eventId: ob.eventId } },
        });
        await this.audit.record(tx, {
          actorId: payerId,
          action: 'payment.pay_cash_requested',
          targetType: 'PaymentObligation',
          targetId: ob.id,
          requestId,
        });
      }
      return this.toDto(payerId, current, tx);
    });
  }

  // ───────────── receiver side ─────────────

  /** Money overview of one game for people who may see the fees. */
  async eventSummary(viewerId: string, eventId: string): Promise<EventMoneySummaryDto> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, currency: true },
    });
    if (!event) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    const target: PolicyTarget = { type: 'EVENT', id: eventId };
    const allowed =
      (await this.policy.can(viewerId, 'event.money.view', target)) ||
      (await this.policy.can(viewerId, 'event.cash.confirm', target));
    if (!allowed)
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');

    // Only confirmed players owe money; waitlisted/pending never appear (no phantom debt).
    const obligations = await this.prisma.paymentObligation.findMany({
      where: { eventId, kind: 'EVENT_FEE', status: { not: 'CANCELLED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const dtos = await Promise.all(obligations.map((o) => this.toDto(viewerId, o, this.prisma)));
    const expected = obligations.reduce((s, o) => s + o.amountMinor, 0);
    const collected = obligations.reduce((s, o) => s + Math.min(o.paidMinor, o.amountMinor), 0);
    return {
      eventId,
      currency: event.currency,
      expectedMinor: expected,
      collectedMinor: collected,
      outstandingMinor: Math.max(0, expected - collected),
      paidCount: obligations.filter((o) => o.status === 'PAID').length,
      obligationCount: obligations.length,
      obligations: dtos,
    };
  }

  /**
   * "Cash received". Requires an Idempotency-Key. One receipt per key even under retries or
   * double taps; a second attempt with a new key after full payment is refused (no double credit).
   */
  async cashReceived(
    actorId: string,
    obligationId: string,
    dto: CashReceivedDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<ObligationDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `payments.cashReceived:${obligationId}`,
        key,
        payload: { amountMinor: dto.amountMinor ?? null, note: dto.note ?? null },
        required: true,
      },
      async (tx) => {
        await lockObligation(tx, obligationId);
        const ob = await tx.paymentObligation.findUnique({ where: { id: obligationId } });
        if (!ob) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');

        await this.assertMayConfirm(actorId, ob, tx);
        if (ob.status === 'CANCELLED') {
          throw new ApiError(ErrorCode.CONFLICT, 'This obligation is cancelled', {
            status: ob.status,
          });
        }
        const remaining = ob.amountMinor - ob.paidMinor;
        if (remaining <= 0) {
          throw new ApiError(ErrorCode.CONFLICT, 'This obligation is already fully paid', {
            status: ob.status,
          });
        }
        const amount = dto.amountMinor ?? remaining;
        if (amount > remaining) {
          // Never park an overpayment in a hidden wallet.
          throw new ApiError(ErrorCode.VALIDATION, 'Amount exceeds the outstanding balance', {
            field: 'amountMinor',
            remainingMinor: remaining,
          });
        }
        await tx.cashReceipt.create({
          data: {
            obligationId,
            amountMinor: amount,
            currency: ob.currency,
            receivedById: actorId,
            receivedAt: this.clock.now(),
            note: dto.note ?? null,
            idempotencyKey: key ?? null,
          },
        });
        const paid = ob.paidMinor + amount;
        const updated = await tx.paymentObligation.update({
          where: { id: obligationId },
          data: {
            paidMinor: paid,
            status: this.statusFor(ob.amountMinor, paid),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'payment.cash_received',
          targetType: 'PaymentObligation',
          targetId: obligationId,
          requestId,
          metadata: { amountMinor: amount, currency: ob.currency, resultingStatus: updated.status },
        });
        if (ob.payerUserId) {
          await this.notifier.notify(tx, {
            recipientIds: [ob.payerUserId],
            category: 'cash',
            activityKind: updated.status === 'PAID' ? 'cash.paid' : 'cash.partially_paid',
            title: updated.status === 'PAID' ? 'Payment confirmed' : 'Partial payment recorded',
            objectType: 'PaymentObligation',
            objectId: obligationId,
            actorId,
            essential: true,
            payload: { eventId: ob.eventId, amountMinor: amount, currency: ob.currency },
            dedupeKey: `cash:${obligationId}:receipt:${key ?? amount}`,
          });
        }
        const receipts = await tx.cashReceipt.findMany({
          where: { obligationId },
          orderBy: { receivedAt: 'asc' },
        });
        const view = await this.toDto(actorId, updated, tx);
        view.receipts = receipts.map(CashReceiptDto.from);
        return view;
      },
    );
  }

  /** Immutable-history correction: never edits a receipt, always appends an adjustment. */
  async adjust(
    actorId: string,
    obligationId: string,
    dto: CreateAdjustmentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<ObligationDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `payments.adjust:${obligationId}`,
        key,
        payload: dto,
        required: true,
      },
      async (tx) => {
        await lockObligation(tx, obligationId);
        const ob = await tx.paymentObligation.findUnique({ where: { id: obligationId } });
        if (!ob) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        const scope = await this.receiverScope(ob, tx);
        if (
          !scope ||
          !(await this.policy.can(actorId, scope.correct.permission, scope.correct.target, tx))
        ) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (ob.payerUserId === actorId) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You cannot adjust your own payment');
        }
        const data: Prisma.PaymentObligationUpdateInput = { version: { increment: 1 } };
        let paid = ob.paidMinor;
        let amount = ob.amountMinor;
        switch (dto.type) {
          case 'CORRECTION': {
            if (dto.deltaMinor === 0 || paid + dto.deltaMinor < 0) {
              throw new ApiError(
                ErrorCode.VALIDATION,
                'Correction would make the paid amount negative',
                { field: 'deltaMinor' },
              );
            }
            paid += dto.deltaMinor;
            data.paidMinor = paid;
            break;
          }
          case 'WAIVER': {
            if (dto.deltaMinor >= 0 || amount + dto.deltaMinor < 0) {
              throw new ApiError(ErrorCode.VALIDATION, 'Waiver must reduce the amount owed', {
                field: 'deltaMinor',
              });
            }
            amount += dto.deltaMinor;
            data.amountMinor = amount;
            break;
          }
          case 'REFUND_DUE': {
            if (
              dto.deltaMinor <= 0 ||
              ob.refundDueMinor + ob.refundedMinor + dto.deltaMinor > ob.paidMinor
            ) {
              throw new ApiError(ErrorCode.VALIDATION, 'Refund exceeds what was paid', {
                field: 'deltaMinor',
              });
            }
            data.refundDueMinor = { increment: dto.deltaMinor };
            break;
          }
          case 'REFUND_PAID': {
            if (dto.deltaMinor <= 0 || dto.deltaMinor > ob.refundDueMinor) {
              throw new ApiError(ErrorCode.VALIDATION, 'Refund paid exceeds refund due', {
                field: 'deltaMinor',
              });
            }
            data.refundDueMinor = { decrement: dto.deltaMinor };
            data.refundedMinor = { increment: dto.deltaMinor };
            break;
          }
        }
        if ((dto.type === 'CORRECTION' || dto.type === 'WAIVER') && ob.status !== 'CANCELLED') {
          data.status = this.statusFor(amount, paid);
        }
        await tx.adjustment.create({
          data: {
            obligationId,
            type: dto.type,
            deltaMinor: dto.deltaMinor,
            reason: dto.reason,
            actorId,
            receiptId: dto.receiptId ?? null,
          },
        });
        const updated = await tx.paymentObligation.update({ where: { id: obligationId }, data });
        await this.audit.record(tx, {
          actorId,
          action: `payment.adjustment.${dto.type.toLowerCase()}`,
          targetType: 'PaymentObligation',
          targetId: obligationId,
          requestId,
          metadata: { type: dto.type, deltaMinor: dto.deltaMinor, reason: dto.reason },
        });
        return this.toDto(actorId, updated, tx);
      },
    );
  }

  // ───────────── policy plumbing ─────────────

  /** Status implied by the amount owed and the amount received. */
  statusFor(amount: number, paid: number): PaymentObligation['status'] {
    if (paid >= amount) return 'PAID';
    if (paid > 0) return 'PARTIALLY_PAID';
    return 'OPEN';
  }

  /** Which permission/target governs receiving cash for this obligation. */
  private async receiverScope(ob: PaymentObligation, db: Db): Promise<ReceiverScope | null> {
    if (ob.kind === 'EVENT_FEE' && ob.eventId) {
      const target: PolicyTarget = { type: 'EVENT', id: ob.eventId };
      return {
        confirm: { permission: 'event.cash.confirm', target },
        correct: { permission: 'event.cash.correct', target },
        view: { permission: 'event.money.view', target },
      };
    }
    if (
      (ob.kind === 'TOURNAMENT_CLUB_FEE' || ob.kind === 'TOURNAMENT_PLAYER_FEE') &&
      ob.tournamentId
    ) {
      const target: PolicyTarget = { type: 'TOURNAMENT', id: ob.tournamentId };
      return {
        confirm: { permission: 'tournament.cash', target },
        correct: { permission: 'tournament.manage', target },
        view: { permission: 'tournament.cash', target },
      };
    }
    if (ob.kind === 'PITCH_RENTAL' && ob.bookingId) {
      const booking = await db.booking.findUnique({
        where: { id: ob.bookingId },
        select: { pitchId: true },
      });
      if (!booking) return null;
      const target: PolicyTarget = { type: 'PITCH', id: booking.pitchId };
      return {
        confirm: { permission: 'pitch.bookings.decide', target },
        correct: { permission: 'pitch.manage', target },
        view: { permission: 'pitch.bookings.decide', target },
      };
    }
    return null;
  }

  private async assertMayConfirm(actorId: string, ob: PaymentObligation, db: Db): Promise<void> {
    // The payer can never confirm their own payment; a club's owner cannot confirm the club's fee to itself.
    if (ob.payerUserId === actorId) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You cannot confirm your own payment');
    }
    if (ob.payerClubId) {
      const club = await db.club.findUnique({
        where: { id: ob.payerClubId },
        select: { ownerId: true },
      });
      if (club?.ownerId === actorId) {
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You cannot confirm your own club’s payment');
      }
    }
    const scope = await this.receiverScope(ob, db);
    if (
      !scope ||
      !(await this.policy.can(actorId, scope.confirm.permission, scope.confirm.target, db))
    ) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  private async loadVisible(viewerId: string, id: string, db: Db): Promise<PaymentObligation> {
    const ob = await db.paymentObligation.findUnique({ where: { id } });
    if (!ob) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    if (ob.payerUserId === viewerId) return ob;
    const scope = await this.receiverScope(ob, db);
    if (
      scope &&
      ((await this.policy.can(viewerId, scope.view.permission, scope.view.target, db)) ||
        (await this.policy.can(viewerId, scope.confirm.permission, scope.confirm.target, db)))
    ) {
      return ob;
    }
    throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
  }

  private async toDto(viewerId: string, ob: PaymentObligation, db: Db): Promise<ObligationDto> {
    const open = ob.status === 'OPEN' || ob.status === 'PARTIALLY_PAID';
    let payCashEnabled = true;
    if (ob.eventId) {
      const ev = await db.event.findUnique({
        where: { id: ob.eventId },
        select: { payCashEnabled: true },
      });
      payCashEnabled = ev?.payCashEnabled ?? false;
    }
    const scope = await this.receiverScope(ob, db);
    const isPayer = ob.payerUserId === viewerId;
    const canConfirm =
      open &&
      !isPayer &&
      scope !== null &&
      (await this.policy.can(viewerId, scope.confirm.permission, scope.confirm.target, db));
    const canCorrect =
      !isPayer &&
      scope !== null &&
      (await this.policy.can(viewerId, scope.correct.permission, scope.correct.target, db));
    const capabilities: ObligationCapabilitiesDto = {
      canPayCash: isPayer && open && payCashEnabled,
      canConfirmCash: canConfirm,
      canCorrect,
      canPayOnline: false,
    };
    const dto = ObligationDto.from(ob, capabilities);
    if (ob.kind === 'EVENT_FEE') {
      const pending = await db.feeAmendment.findFirst({
        where: { obligationId: ob.id, status: 'PENDING' },
        select: { id: true, newAmountMinor: true, version: true },
      });
      if (pending) dto.pendingAmendment = pending;
    }
    return dto;
  }

  /** The obligation as `viewerId` may see it (capabilities + pending amendment). */
  obligationView(viewerId: string, ob: PaymentObligation, db: Db): Promise<ObligationDto> {
    return this.toDto(viewerId, ob, db);
  }

  /** Users who may currently confirm this obligation (excluding the payer). */
  private async eligibleReceiverIds(db: Db, ob: PaymentObligation): Promise<string[]> {
    const now = this.clock.now();
    const ids = new Set<string>();
    const validGrant = { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    if (ob.kind === 'EVENT_FEE' && ob.eventId) {
      const ev = await db.event.findUnique({
        where: { id: ob.eventId },
        select: { organiserId: true, clubId: true, club: { select: { ownerId: true } } },
      });
      if (ev) {
        if (ev.club?.ownerId) ids.add(ev.club.ownerId);
        if (
          !ev.clubId &&
          this.config.get('CASUAL_CASH_RECEIVER_POLICY', { infer: true }) === 'ORGANISER'
        ) {
          ids.add(ev.organiserId);
        }
        const grants = await db.roleGrant.findMany({
          where: {
            ...validGrant,
            OR: [
              {
                resourceType: 'EVENT',
                resourceId: ob.eventId,
                permission: { in: ['event.cash.confirm', 'club.money.confirmCash'] },
              },
              ...(ev.clubId
                ? [
                    {
                      resourceType: 'CLUB' as const,
                      resourceId: ev.clubId,
                      permission: 'club.money.confirmCash',
                    },
                  ]
                : []),
            ],
          },
          select: { granteeId: true },
        });
        grants.forEach((g) => ids.add(g.granteeId));
      }
    }
    if (ob.payerUserId) ids.delete(ob.payerUserId);
    return [...ids];
  }
}
