import { Injectable } from '@nestjs/common';
import type { Audience, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PrivacyDto, type UpdatePrivacyDto } from './dto';

const AUDIENCE_FIELDS = [
  'postsAudience',
  'historyAudience',
  'statsAudience',
  'awardsAudience',
  'clubsAudience',
  'ratingsAudience',
  'cityAudience',
  'ageAudience',
  'followListAudience',
] as const;

@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async get(userId: string): Promise<PrivacyDto> {
    const [policy, profile] = await Promise.all([
      this.prisma.privacyPolicy.findUnique({ where: { userId } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { visibility: true } }),
    ]);
    if (!policy || !profile) throw new ApiError(ErrorCode.NOT_FOUND, 'Profile not found');
    return PrivacyDto.from(policy, profile.visibility);
  }

  /**
   * Updates privacy. Rules (Handoff §8):
   *  - PRIVATE caps every audience at FOLLOWERS; switching Public → Private narrows stored
   *    EVERYONE values *and* the user's PUBLIC posts immediately;
   *  - switching back to PUBLIC never re-opens anything automatically;
   *  - while PRIVATE, setting an audience to EVERYONE is rejected (VALIDATION).
   */
  async update(userId: string, dto: UpdatePrivacyDto, requestId?: string): Promise<PrivacyDto> {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { visibility: true },
      });
      if (!profile) throw new ApiError(ErrorCode.NOT_FOUND, 'Profile not found');
      const nextVisibility = dto.profileVisibility ?? profile.visibility;

      const data: Prisma.PrivacyPolicyUpdateInput = {};
      for (const f of AUDIENCE_FIELDS) {
        const v: Audience | undefined = dto[f];
        if (v === undefined) continue;
        if (nextVisibility === 'PRIVATE' && v === 'EVERYONE') {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'A private profile cannot use the Everyone audience',
            {
              field: f,
            },
          );
        }
        data[f] = v;
      }
      if (dto.messagePolicy) data.messagePolicy = dto.messagePolicy;
      if (dto.invitationPolicy) data.invitationPolicy = dto.invitationPolicy;
      if (dto.mentionPolicy) data.mentionPolicy = dto.mentionPolicy;
      if (dto.reviewTags !== undefined) data.reviewTags = dto.reviewTags;
      if (dto.externalMediaSharing !== undefined)
        data.externalMediaSharing = dto.externalMediaSharing;

      if (dto.profileVisibility && dto.profileVisibility !== profile.visibility) {
        await tx.profile.update({ where: { userId }, data: { visibility: dto.profileVisibility } });
        if (dto.profileVisibility === 'PRIVATE') {
          for (const f of AUDIENCE_FIELDS) {
            if (dto[f] === undefined) {
              await tx.privacyPolicy.updateMany({
                where: { userId, [f]: 'EVERYONE' },
                data: { [f]: 'FOLLOWERS' },
              });
            }
          }
          await tx.post.updateMany({
            where: {
              authorType: 'USER',
              authorEntityId: userId,
              audience: 'PUBLIC',
              status: { not: 'DELETED' },
            },
            data: { audience: 'FOLLOWERS' },
          });
        }
        await this.audit.record(tx, {
          actorId: userId,
          action: 'privacy.visibility_changed',
          targetType: 'User',
          targetId: userId,
          requestId,
          metadata: { from: profile.visibility, to: dto.profileVisibility },
        });
      }
      if (Object.keys(data).length > 0) {
        await tx.privacyPolicy.update({ where: { userId }, data });
      }
      const policy = await tx.privacyPolicy.findUniqueOrThrow({ where: { userId } });
      return PrivacyDto.from(policy, nextVisibility);
    });
  }

  // ── Blocks ──

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId)
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot block yourself');
    const target = await this.prisma.user.findUnique({
      where: { id: blockedId },
      select: { id: true },
    });
    if (!target) throw new ApiError(ErrorCode.NOT_FOUND, 'User not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      });
      // Block removes social links between the pair and mutes recommendations, but does NOT
      // cancel bookings, debts, confirmed squads or official results.
      await tx.follow.deleteMany({
        where: {
          targetType: 'USER',
          OR: [
            { followerId: blockerId, targetId: blockedId },
            { followerId: blockedId, targetId: blockerId },
          ],
        },
      });
      await tx.favourite.deleteMany({
        where: { userId: blockedId, targetType: 'USER', targetId: blockerId },
      });
    });
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
  }

  async listBlocked(blockerId: string) {
    const rows = await this.prisma.block.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const profiles = await this.prisma.profile.findMany({
      where: { userId: { in: rows.map((r) => r.blockedId) } },
      select: { userId: true, nickname: true, username: true },
    });
    const byId = new Map(profiles.map((p) => [p.userId, p]));
    return rows.map((r) => ({
      userId: r.blockedId,
      nickname: byId.get(r.blockedId)?.nickname ?? null,
      username: byId.get(r.blockedId)?.username ?? null,
      blockedAt: r.createdAt.toISOString(),
    }));
  }
}
