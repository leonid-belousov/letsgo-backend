import { Injectable } from '@nestjs/common';
import type { Prisma, PrivacyPolicy, Profile } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import { ageOn } from '../../common/time/local-time';
import { isUniqueViolation } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { OwnerProfileDto, PublicProfileDto, UpdateProfileDto, USERNAME_PATTERN } from './dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
  ) {}

  async getOwn(userId: string): Promise<OwnerProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, identities: { select: { provider: true, subject: true } } },
    });
    if (!user?.profile) throw new ApiError(ErrorCode.NOT_FOUND, 'Profile not found');
    const p = user.profile;
    return {
      id: user.id,
      nickname: p.nickname,
      username: p.username,
      dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
      city: p.city,
      bio: p.bio,
      avatarId: p.avatarId,
      visibility: p.visibility,
      profileComplete: p.completedAt !== null,
      version: p.version,
      email: user.identities.find((i) => i.provider === 'EMAIL')?.subject ?? null,
      phone: user.identities.find((i) => i.provider === 'PHONE')?.subject ?? null,
    };
  }

  async updateOwn(userId: string, dto: UpdateProfileDto): Promise<OwnerProfileDto> {
    const username = dto.username?.trim().toLowerCase();
    if (username !== undefined && !USERNAME_PATTERN.test(username)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Invalid username', { field: 'username' });
    }
    if (dto.dateOfBirth) {
      const now = this.clock.now();
      const ageYears = ageOn(dto.dateOfBirth, now, 'UTC');
      if (dto.dateOfBirth > now || ageYears > 120) {
        throw new ApiError(ErrorCode.VALIDATION, 'Invalid date of birth', { field: 'dateOfBirth' });
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.profile.findUnique({ where: { userId } });
        if (!current) throw new ApiError(ErrorCode.NOT_FOUND, 'Profile not found');
        if (dto.version !== undefined && dto.version !== current.version) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'Profile was changed elsewhere', {
            currentVersion: current.version,
          });
        }
        const data: Prisma.ProfileUpdateInput = { version: { increment: 1 } };
        if (dto.avatarId !== undefined) {
          if (dto.avatarId === null) data.avatarId = null;
          else {
            const asset = await tx.mediaAsset.findUnique({
              where: { id: dto.avatarId },
              select: { ownerId: true, kind: true, status: true },
            });
            // someone else's or unfinished media looks exactly like a missing one
            if (
              !asset ||
              asset.ownerId !== userId ||
              asset.kind !== 'PHOTO' ||
              asset.status !== 'READY'
            ) {
              throw new ApiError(ErrorCode.VALIDATION, 'Choose one of your finished photos', {
                field: 'avatarId',
              });
            }
            data.avatarId = dto.avatarId;
          }
        }
        if (dto.nickname !== undefined) data.nickname = dto.nickname.trim();
        if (username !== undefined) data.username = username;
        if (dto.dateOfBirth !== undefined) data.dateOfBirth = dto.dateOfBirth;
        if (dto.city !== undefined) data.city = dto.city.trim();
        if (dto.bio !== undefined) data.bio = dto.bio;

        const nextNickname = dto.nickname?.trim() ?? current.nickname;
        const nextUsername = username ?? current.username;
        const nextDob = dto.dateOfBirth ?? current.dateOfBirth;
        const nextCity = dto.city?.trim() ?? current.city;
        const complete = !!(nextNickname && nextUsername && nextDob && nextCity);
        const firstCompletion = complete && current.completedAt === null;
        if (firstCompletion) data.completedAt = this.clock.now();

        await tx.profile.update({ where: { userId }, data });

        if (firstCompletion) {
          // New joiner: dated welcome achievement (Decisions §5) — not evidence of few games.
          await tx.achievement.create({
            data: { type: 'NEW_JOINER', recipientId: userId, title: 'New joiner' },
          });
        }
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ApiError(ErrorCode.CONFLICT, 'This username is taken.', { field: 'username' });
      }
      throw e;
    }
    return this.getOwn(userId);
  }

  async isUsernameAvailable(username: string): Promise<boolean> {
    const u = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(u)) return false;
    const found = await this.prisma.profile.findUnique({
      where: { username: u },
      select: { userId: true },
    });
    return found === null;
  }

  async getPublic(viewerId: string | null, targetId: string): Promise<PublicProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      include: { profile: true, privacy: true },
    });
    if (!user?.profile || !user.privacy || user.status === 'DELETED') {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    return this.buildPublic(viewerId, user.id, user.profile, user.privacy);
  }

  async getPublicByUsername(viewerId: string | null, username: string): Promise<PublicProfileDto> {
    const profile = await this.prisma.profile.findUnique({
      where: { username: username.trim().toLowerCase() },
    });
    if (!profile) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.getPublic(viewerId, profile.userId);
  }

  private async buildPublic(
    viewerId: string | null,
    id: string,
    profile: Profile,
    privacy: PrivacyPolicy,
  ): Promise<PublicProfileDto> {
    const rel = await this.visibility.relationship(viewerId, id);
    const dto = new PublicProfileDto();
    dto.id = id;
    dto.nickname = profile.nickname;
    dto.username = profile.username;
    dto.avatarId = profile.avatarId;
    dto.visibility = profile.visibility;
    dto.followStatus = rel.following;
    if (this.visibility.canSee(privacy.cityAudience, profile.visibility, rel))
      dto.city = profile.city;
    if (this.visibility.canSee(privacy.postsAudience, profile.visibility, rel))
      dto.bio = profile.bio;
    if (
      profile.dateOfBirth &&
      this.visibility.canSee(privacy.ageAudience, profile.visibility, rel)
    ) {
      dto.age = ageOn(profile.dateOfBirth, this.clock.now(), 'UTC');
    }
    const loggedIn = viewerId !== null;
    dto.capabilities = {
      canFollow: loggedIn && !rel.isSelf && !rel.blocked && rel.following === null,
      canUnfollow: loggedIn && !rel.isSelf && rel.following !== null,
      canMessage: this.visibility.canMessage(privacy, rel),
      canFavourite: loggedIn && !rel.isSelf && !rel.blocked,
      canBlock: loggedIn && !rel.isSelf,
      canReport: loggedIn && !rel.isSelf,
    };
    return dto;
  }
}
