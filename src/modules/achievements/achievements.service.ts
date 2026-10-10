import { Injectable } from '@nestjs/common';
import type { Achievement } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
} from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import {
  UserAchievementsDto,
  type AchievementDto,
  type GrantAchievementDto,
  type StaffAchievementDto,
} from './dto';

const NOT_AVAILABLE = 'This content isn’t available';
const DEFAULT_TITLE: Record<string, string> = {
  FAIR_PLAY: 'Fair play',
  LEADERSHIP: 'Leadership',
  TROPHY: 'Trophy',
};

@Injectable()
export class AchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Awards shown on a profile; honours the owner's awards audience. Hidden ⇒ no list at all. */
  async listForUser(
    viewerId: string | null,
    userId: string,
    q: { limit?: number; cursor?: string },
  ): Promise<UserAchievementsDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, privacy: true },
    });
    if (!user?.profile || !user.privacy || user.status === 'DELETED') {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const out = new UserAchievementsDto();
    out.userId = userId;
    const rel = await this.visibility.relationship(viewerId, userId);
    if (!this.visibility.canSee(user.privacy.awardsAudience, user.profile.visibility, rel)) {
      out.hidden = true;
      return out;
    }
    out.hidden = false;
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.achievement.findMany({
      where: {
        recipientId: userId,
        revokedAt: null,
        ...keysetBefore('awardedAt', decodeCursor(q.cursor)),
      },
      orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.awardedAt.toISOString(), id: r.id }));
    out.items = page.items.map((r) => this.toDto(r));
    out.nextCursor = page.nextCursor;
    return out;
  }

  // ───────────── staff ─────────────

  async grant(
    staffId: string,
    dto: GrantAchievementDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<StaffAchievementDto> {
    await this.policy.assert(staffId, 'admin.achievements.grant', { type: 'PLATFORM' });
    return this.idempotency.execute(
      { userId: staffId, scope: 'achievements.grant', key, payload: dto },
      async (tx) => {
        const recipient = await tx.user.findUnique({
          where: { id: dto.recipientId },
          select: { status: true },
        });
        if (!recipient || recipient.status === 'DELETED') {
          throw new ApiError(ErrorCode.VALIDATION, 'Unknown recipient', { field: 'recipientId' });
        }
        if (dto.sourceMatchId) {
          const m = await tx.match.findUnique({
            where: { id: dto.sourceMatchId },
            select: { status: true },
          });
          if (m?.status !== 'CONFIRMED') {
            throw new ApiError(ErrorCode.VALIDATION, 'The source must be a confirmed match', {
              field: 'sourceMatchId',
            });
          }
        }
        if (dto.sourceTournamentId) {
          const t = await tx.tournament.findUnique({
            where: { id: dto.sourceTournamentId },
            select: { id: true },
          });
          if (!t) {
            throw new ApiError(ErrorCode.VALIDATION, 'Unknown tournament', {
              field: 'sourceTournamentId',
            });
          }
        }
        if (dto.sourceMatchId || dto.sourceTournamentId) {
          const dup = await tx.achievement.findFirst({
            where: {
              recipientId: dto.recipientId,
              type: dto.type,
              revokedAt: null,
              sourceMatchId: dto.sourceMatchId ?? null,
              sourceTournamentId: dto.sourceTournamentId ?? null,
            },
            select: { id: true },
          });
          if (dup) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'This award was already granted for that activity',
            );
          }
        }
        const row = await tx.achievement.create({
          data: {
            type: dto.type,
            recipientId: dto.recipientId,
            title: dto.title?.trim() || (DEFAULT_TITLE[dto.type] as string),
            description: dto.description?.trim() || null,
            grantedById: staffId,
            sourceMatchId: dto.sourceMatchId ?? null,
            sourceTournamentId: dto.sourceTournamentId ?? null,
            awardedAt: this.clock.now(),
          },
        });
        await this.audit.record(tx, {
          actorId: staffId,
          action: 'achievement.grant',
          targetType: 'Achievement',
          targetId: row.id,
          requestId,
          metadata: {
            recipientId: dto.recipientId,
            type: dto.type,
            reason: dto.reason,
            sourceMatchId: dto.sourceMatchId ?? null,
            sourceTournamentId: dto.sourceTournamentId ?? null,
          },
        });
        await this.notifier.notify(tx, {
          recipientIds: [dto.recipientId],
          category: 'system',
          activityKind: 'achievement.granted',
          title: 'You received an award',
          objectType: 'Achievement',
          objectId: row.id,
          essential: true,
          dedupeKey: `achievement:${row.id}:granted`,
        });
        return this.toStaffDto(row);
      },
    );
  }

  async revoke(
    staffId: string,
    achievementId: string,
    reason: string,
    requestId?: string,
  ): Promise<StaffAchievementDto> {
    await this.policy.assert(staffId, 'admin.achievements.grant', { type: 'PLATFORM' });
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.achievement.findUnique({ where: { id: achievementId } });
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (!['FAIR_PLAY', 'LEADERSHIP', 'TROPHY'].includes(row.type)) {
        throw new ApiError(ErrorCode.CONFLICT, 'This kind of award is not revoked by staff', {
          type: row.type,
        });
      }
      if (row.revokedAt) return this.toStaffDto(row);
      const updated = await tx.achievement.update({
        where: { id: achievementId },
        data: { revokedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        actorId: staffId,
        action: 'achievement.revoke',
        targetType: 'Achievement',
        targetId: achievementId,
        requestId,
        metadata: { recipientId: row.recipientId, type: row.type, reason },
      });
      return this.toStaffDto(updated);
    });
  }

  private toDto(a: Achievement): AchievementDto {
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      clubId: a.clubId,
      isClubAward: a.type === 'CLUB_AWARD',
      sourceMatchId: a.sourceMatchId,
      sourceTournamentId: a.sourceTournamentId,
      awardedAt: a.awardedAt.toISOString(),
    };
  }

  private toStaffDto(a: Achievement): StaffAchievementDto {
    return {
      ...this.toDto(a),
      recipientId: a.recipientId,
      grantedById: a.grantedById,
      revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null,
    };
  }
}
