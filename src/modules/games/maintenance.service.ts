import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock';
import { lockEvent } from '../../common/transactions/tx';
import { Notifier } from '../../common/notify/notifier.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { GamesService } from './games.service';
import { InvitationsService } from './invitations.service';
import { ParticipationService } from './participation.service';

export interface MaintenanceReport {
  expiredHolds: number;
  expiredInvitations: number;
  expiredOffers: number;
  autoCancelled: number;
  nextWaves: number;
  invitationsCreated: number;
}

/**
 * Time-driven housekeeping. Correctness never depends on it (free seats ignore expired holds and
 * offers by timestamp); it persists the outcome, notifies people and passes freed seats on.
 * Each event is processed in its own transaction under the event row lock, so several instances
 * can run it concurrently without double-processing.
 */
@Injectable()
export class GamesMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly participation: ParticipationService,
    private readonly games: GamesService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly invitations: InvitationsService,
  ) {}

  /**
   * `scope.eventIds` restricts processing to those events. Production leaves it undefined (everything
   * due); tests use it so suites sharing one database with different fake clocks cannot process each
   * other's events.
   */
  async tick(scope?: { eventIds?: string[] }): Promise<MaintenanceReport> {
    const now = this.clock.now();
    const report: MaintenanceReport = {
      expiredHolds: 0,
      expiredInvitations: 0,
      expiredOffers: 0,
      autoCancelled: 0,
      nextWaves: 0,
      invitationsCreated: 0,
    };

    const eventIds = new Set<string>();
    const [holds, invs, offers, autos] = await Promise.all([
      this.prisma.seatHold.findMany({
        where: { releasedAt: null, expiresAt: { lte: now } },
        select: { eventId: true },
      }),
      this.prisma.invitation.findMany({
        where: { status: 'PENDING', respondBy: { lte: now } },
        select: { eventId: true },
      }),
      this.prisma.waitlistOffer.findMany({
        where: { status: 'OFFERED', expiresAt: { lte: now } },
        select: { eventId: true },
      }),
      this.prisma.event.findMany({
        where: { status: 'PUBLISHED', autoCancelEnabled: true, autoCancelCheckAt: { lte: now } },
        select: { id: true },
      }),
    ]);
    [...holds, ...invs, ...offers].forEach((r) => eventIds.add(r.eventId));
    autos.forEach((r) => eventIds.add(r.id));

    if (scope?.eventIds) {
      const allowed = new Set(scope.eventIds);
      for (const id of [...eventIds]) if (!allowed.has(id)) eventIds.delete(id);
    }
    for (const eventId of eventIds) {
      await this.prisma.$transaction(async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) return;

        // 1) priority holds whose deadline passed → released; invitation expires
        const dueHolds = await tx.seatHold.findMany({
          where: { eventId, releasedAt: null, expiresAt: { lte: now } },
        });
        for (const h of dueHolds) {
          await tx.seatHold.update({
            where: { id: h.id },
            data: { releasedAt: now, releaseReason: 'EXPIRED' },
          });
          await tx.invitation.updateMany({
            where: { id: h.invitationId, status: 'PENDING' },
            data: { status: 'EXPIRED', respondedAt: now },
          });
          report.expiredHolds += 1;
          await this.notifier.notify(tx, {
            recipientIds: [h.userId],
            category: 'invitation',
            activityKind: 'invitation.expired',
            title: 'Your invitation expired',
            objectType: 'Event',
            objectId: eventId,
            essential: true,
            dedupeKey: `invitation:${h.invitationId}:expired`,
          });
        }
        // 1b) priority deadline reached ⇒ offer the freed places to the remaining club players
        const expiredPriority = dueHolds.length > 0;

        // 2) ordinary invitations past their deadline
        const expiredInv = await tx.invitation.updateMany({
          where: { eventId, status: 'PENDING', respondBy: { lte: now } },
          data: { status: 'EXPIRED', respondedAt: now },
        });
        report.expiredInvitations += expiredInv.count;

        // 3) waitlist offers that timed out → the player leaves the queue, next player is offered
        const dueOffers = await tx.waitlistOffer.findMany({
          where: { eventId, status: 'OFFERED', expiresAt: { lte: now } },
        });
        for (const o of dueOffers) {
          await tx.waitlistOffer.update({
            where: { id: o.id },
            data: { status: 'EXPIRED', respondedAt: now },
          });
          await tx.participation.updateMany({
            where: { id: o.participationId, status: 'WAITLISTED' },
            data: { status: 'WITHDRAWN' },
          });
          report.expiredOffers += 1;
          await this.notifier.notify(tx, {
            recipientIds: [o.userId],
            category: 'game',
            activityKind: 'waitlist.offer_expired',
            title: 'The offered place expired',
            objectType: 'Event',
            objectId: eventId,
            essential: true,
            dedupeKey: `waitlist-offer:${o.id}:expired`,
          });
        }

        // 4) organiser-configured auto-cancel (never for merely unfilled seats: only below the minimum)
        const fresh = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
        if (
          fresh.status === 'PUBLISHED' &&
          fresh.autoCancelEnabled &&
          fresh.autoCancelCheckAt &&
          fresh.autoCancelCheckAt <= now &&
          fresh.minConfirmed
        ) {
          const confirmed = await tx.participation.count({
            where: { eventId, status: 'CONFIRMED' },
          });
          if (confirmed < fresh.minConfirmed) {
            await this.games.cancelInside(
              tx,
              fresh,
              fresh.organiserId,
              `Not enough confirmed players (${confirmed}/${fresh.minConfirmed})`,
              'event.auto_cancelled',
            );
            report.autoCancelled += 1;
            return;
          }
          // Enough players: the check is done; disarm it so it is not re-evaluated
          await tx.event.update({ where: { id: eventId }, data: { autoCancelCheckAt: null } });
        }
        const after = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
        // Waitlisted players are offered freed places first; the next club wave follows.
        await this.participation.promoteWaitlist(tx, after);
        if (expiredPriority && after.autoNextWave && after.clubId && after.status === 'PUBLISHED') {
          const wave = await this.invitations.nextWave(tx, after, after.organiserId, null);
          if (wave.created.length > 0) {
            report.nextWaves += 1;
            report.invitationsCreated += wave.created.length;
          }
        }
      });
    }
    return report;
  }
}
