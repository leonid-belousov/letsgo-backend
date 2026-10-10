import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Event, type Rating, type RatingSubject } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
} from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { isUniqueViolation, type Db } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { loadPersonSummaries } from '../users/person-summary';
import {
  AdminRatingDto,
  EventRatingsDto,
  RatingDto,
  RatingsGivenPageDto,
  RatingsReceivedPageDto,
  SubjectRatingDto,
  type RateableSubjectDto,
  type UpsertRatingDto,
} from './dto';

export interface RatingSummary {
  /** Simple arithmetic mean rounded to one decimal; null when nothing was rated (never 0). */
  average: number | null;
  count: number;
}

const RATEABLE_STATES: Event['status'][] = ['FINISHED', 'RESULT_PENDING', 'RESULT_CONFIRMED'];
const NOT_AVAILABLE = 'This content isn’t available';
const USER_SUBJECTS: RatingSubject[] = ['PLAYER', 'ORGANISER', 'REFEREE'];

@Injectable()
export class RatingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Aggregates for other modules (game cards, venue pages…). Ids without ratings map to null/0. */
  async summaryFor(
    db: Db,
    type: RatingSubject,
    ids: string[],
  ): Promise<Map<string, RatingSummary>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, RatingSummary>(
      unique.map((id) => [id, { average: null, count: 0 }]),
    );
    if (unique.length === 0) return out;
    const rows = await db.rating.groupBy({
      by: ['subjectId'],
      where: { subjectType: type, subjectId: { in: unique }, hiddenAt: null },
      _avg: { score: true },
      _count: { _all: true },
    });
    for (const r of rows) {
      out.set(r.subjectId, {
        average: r._avg.score === null ? null : Math.round(r._avg.score * 10) / 10,
        count: r._count._all,
      });
    }
    return out;
  }

  // ───────────── write ─────────────

  async upsert(authorId: string, dto: UpsertRatingDto): Promise<RatingDto> {
    const extended = this.cleanExtended(dto.extended);
    const comment = dto.comment?.trim() ? dto.comment.trim() : null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const ev = await tx.event.findUnique({ where: { id: dto.eventId } });
          if (!ev || ev.status === 'DRAFT') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
          const part = await tx.participation.findUnique({
            where: { eventId_userId: { eventId: ev.id, userId: authorId } },
            select: { status: true },
          });
          if (part?.status !== 'CONFIRMED') {
            throw new ApiError(
              ErrorCode.ACCESS_DENIED,
              'Only confirmed players of this game can rate it.',
            );
          }
          if (!RATEABLE_STATES.includes(ev.status)) {
            throw new ApiError(ErrorCode.CONFLICT, 'Ratings open when the game is finished', {
              status: ev.status,
            });
          }
          await this.assertSubject(tx, ev, authorId, dto.subjectType, dto.subjectId);
          const now = this.clock.now();
          const confirmedEnd = await this.confirmedWindowEnd(tx, ev);
          const existing = await tx.rating.findUnique({
            where: {
              authorId_subjectType_subjectId_eventId: {
                authorId,
                subjectType: dto.subjectType,
                subjectId: dto.subjectId,
                eventId: ev.id,
              },
            },
          });
          if (!existing) {
            const created = await tx.rating.create({
              data: {
                authorId,
                subjectType: dto.subjectType,
                subjectId: dto.subjectId,
                eventId: ev.id,
                score: dto.score,
                comment,
                extended: extended ?? Prisma.DbNull,
                editableUntil: confirmedEnd ?? this.windowFrom(now),
              },
            });
            return this.toDto(created, now);
          }
          if (existing.hiddenAt) {
            throw new ApiError(ErrorCode.CONFLICT, 'This rating was hidden by moderation', {
              reason: 'HIDDEN_BY_MODERATION',
            });
          }
          // The window may only grow (when the result gets confirmed later), never shrink.
          const until =
            confirmedEnd && confirmedEnd > existing.editableUntil
              ? confirmedEnd
              : existing.editableUntil;
          if (now > until) {
            throw new ApiError(ErrorCode.EXPIRED, 'The time to edit this rating has passed', {
              editableUntil: until.toISOString(),
            });
          }
          const updated = await tx.rating.update({
            where: { id: existing.id },
            data: {
              score: dto.score,
              comment,
              extended: extended ?? Prisma.DbNull,
              editableUntil: until,
            },
          });
          return this.toDto(updated, now);
        });
      } catch (e) {
        // Two first-time submissions raced: the loser simply becomes an edit.
        if (isUniqueViolation(e) && attempt < 2) continue;
        throw e;
      }
    }
  }

  private windowFrom(base: Date): Date {
    return new Date(
      base.getTime() + this.config.get('RATING_EDIT_DAYS', { infer: true }) * 86_400_000,
    );
  }

  /** N days after the latest confirmed match, once the event's result is confirmed. */
  private async confirmedWindowEnd(db: Db, ev: Event): Promise<Date | null> {
    if (ev.status !== 'RESULT_CONFIRMED') return null;
    const agg = await db.match.aggregate({
      where: { eventId: ev.id, status: 'CONFIRMED' },
      _max: { confirmedAt: true },
    });
    return agg._max.confirmedAt ? this.windowFrom(agg._max.confirmedAt) : null;
  }

  private async assertSubject(
    db: Db,
    ev: Event,
    authorId: string,
    type: RatingSubject,
    subjectId: string,
  ): Promise<void> {
    const bad = (message: string) =>
      new ApiError(ErrorCode.VALIDATION, message, { field: 'subjectId' });
    if (USER_SUBJECTS.includes(type) && subjectId === authorId) {
      throw bad('You cannot rate yourself');
    }
    switch (type) {
      case 'PLAYER': {
        const p = await db.participation.findUnique({
          where: { eventId_userId: { eventId: ev.id, userId: subjectId } },
          select: { status: true },
        });
        if (p?.status !== 'CONFIRMED') throw bad('That person did not play in this game');
        return;
      }
      case 'ORGANISER':
        if (ev.organiserId !== subjectId) throw bad('That person did not organise this game');
        return;
      case 'REFEREE':
        if (ev.refereeUserId !== subjectId)
          throw bad('That person was not the referee of this game');
        return;
      case 'PITCH':
        if (ev.pitchId !== subjectId) throw bad('This game was not played on that pitch');
        return;
      case 'VENUE':
        if (ev.venueId !== subjectId) throw bad('This game was not played at that venue');
        return;
    }
  }

  private cleanExtended(raw: Record<string, unknown> | undefined): Prisma.InputJsonObject | null {
    if (raw === undefined) return null;
    const entries = Object.entries(raw);
    if (entries.length > 20) {
      throw new ApiError(ErrorCode.VALIDATION, 'Too many characteristics (max 20)', {
        field: 'extended',
      });
    }
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of entries) {
      const okValue =
        typeof v === 'boolean' ||
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && v.length <= 200);
      if (k.length === 0 || k.length > 40 || !okValue) {
        throw new ApiError(ErrorCode.VALIDATION, 'Invalid characteristic', {
          field: 'extended',
          key: k.slice(0, 40),
        });
      }
      out[k] = v as string | number | boolean;
    }
    return out;
  }

  // ───────────── reads ─────────────

  async subjectAggregate(
    viewerId: string | null,
    type: RatingSubject,
    subjectId: string,
  ): Promise<SubjectRatingDto> {
    const dto = new SubjectRatingDto();
    dto.subjectType = type;
    dto.subjectId = subjectId;
    if (USER_SUBJECTS.includes(type)) {
      const user = await this.prisma.user.findUnique({
        where: { id: subjectId },
        include: { profile: true, privacy: true },
      });
      if (!user?.profile || !user.privacy || user.status === 'DELETED') {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      if (type === 'PLAYER') {
        const rel = await this.visibility.relationship(viewerId, subjectId);
        if (!this.visibility.canSee(user.privacy.ratingsAudience, user.profile.visibility, rel)) {
          dto.hidden = true;
          return dto;
        }
      }
    } else if (type === 'PITCH') {
      const p = await this.prisma.pitch.findUnique({
        where: { id: subjectId },
        select: { status: true, venue: { select: { status: true } } },
      });
      if (!p || p.status === 'DRAFT' || p.venue.status === 'DRAFT') {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
    } else {
      const v = await this.prisma.venue.findUnique({
        where: { id: subjectId },
        select: { status: true },
      });
      if (!v || v.status === 'DRAFT') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const s = (await this.summaryFor(this.prisma, type, [subjectId])).get(subjectId);
    dto.hidden = false;
    dto.average = s?.average ?? null;
    dto.count = s?.count ?? 0;
    return dto;
  }

  async given(
    userId: string,
    q: { limit?: number; cursor?: string },
  ): Promise<RatingsGivenPageDto> {
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.rating.findMany({
      where: { authorId: userId, ...keysetBefore('createdAt', decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const now = this.clock.now();
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return { items: page.items.map((r) => this.toDto(r, now)), nextCursor: page.nextCursor };
  }

  async received(
    userId: string,
    q: { limit?: number; cursor?: string },
  ): Promise<RatingsReceivedPageDto> {
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.rating.findMany({
      where: {
        subjectId: userId,
        subjectType: { in: USER_SUBJECTS },
        hiddenAt: null,
        ...keysetBefore('createdAt', decodeCursor(q.cursor)),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: page.items.map((r) => ({
        id: r.id,
        subjectType: r.subjectType,
        eventId: r.eventId,
        score: r.score,
        comment: r.comment,
        extended: (r.extended as Record<string, unknown> | null) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Who the viewer may rate for one event, with their existing ratings. */
  async forEvent(userId: string, eventId: string): Promise<EventRatingsDto> {
    const ev = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { pitch: { select: { name: true } }, venue: { select: { name: true } } },
    });
    if (!ev || ev.status === 'DRAFT') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const part = await this.prisma.participation.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { status: true },
    });
    const canRate = part?.status === 'CONFIRMED' && RATEABLE_STATES.includes(ev.status);
    const out = new EventRatingsDto();
    out.eventId = eventId;
    out.canRate = canRate;
    out.subjects = [];
    if (!canRate) return out;
    const players = await this.prisma.participation.findMany({
      where: { eventId, status: 'CONFIRMED', userId: { not: userId } },
      select: { userId: true },
    });
    const userIds = [
      ev.organiserId,
      ...(ev.refereeUserId ? [ev.refereeUserId] : []),
      ...players.map((p) => p.userId),
    ];
    const people = await loadPersonSummaries(this.prisma, userIds);
    const mine = await this.prisma.rating.findMany({ where: { authorId: userId, eventId } });
    const now = this.clock.now();
    const key = (t: RatingSubject, id: string) => `${t}:${id}`;
    const byKey = new Map(mine.map((r) => [key(r.subjectType, r.subjectId), r]));
    const add = (t: RatingSubject, id: string, name: string | null) => {
      const r = byKey.get(key(t, id));
      const s: RateableSubjectDto = {
        subjectType: t,
        subjectId: id,
        name,
        myRating: r ? this.toDto(r, now) : null,
      };
      out.subjects.push(s);
    };
    if (ev.organiserId !== userId)
      add('ORGANISER', ev.organiserId, people.get(ev.organiserId)?.nickname ?? null);
    if (ev.refereeUserId && ev.refereeUserId !== userId) {
      add('REFEREE', ev.refereeUserId, people.get(ev.refereeUserId)?.nickname ?? null);
    }
    for (const p of players) add('PLAYER', p.userId, people.get(p.userId)?.nickname ?? null);
    if (ev.pitchId) add('PITCH', ev.pitchId, ev.pitch?.name ?? null);
    if (ev.venueId) add('VENUE', ev.venueId, ev.venue?.name ?? null);
    return out;
  }

  // ───────────── moderation ─────────────

  async setHidden(
    staffId: string,
    ratingId: string,
    hidden: boolean,
    reason: string,
    requestId?: string,
  ): Promise<AdminRatingDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.rating.findUnique({ where: { id: ratingId } });
      if (!r) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if ((r.hiddenAt !== null) !== hidden) {
        const updated = await tx.rating.update({
          where: { id: ratingId },
          data: { hiddenAt: hidden ? this.clock.now() : null },
        });
        await this.audit.record(tx, {
          actorId: staffId,
          action: hidden ? 'rating.hide' : 'rating.unhide',
          targetType: 'Rating',
          targetId: ratingId,
          requestId,
          metadata: {
            reason,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            eventId: r.eventId,
          },
        });
        return {
          id: updated.id,
          hidden,
          hiddenAt: updated.hiddenAt ? updated.hiddenAt.toISOString() : null,
        };
      }
      return { id: r.id, hidden, hiddenAt: r.hiddenAt ? r.hiddenAt.toISOString() : null };
    });
  }

  private toDto(r: Rating, now: Date): RatingDto {
    return {
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      eventId: r.eventId,
      score: r.score,
      comment: r.comment,
      extended: (r.extended as Record<string, unknown> | null) ?? null,
      editableUntil: r.editableUntil.toISOString(),
      canEdit: now <= r.editableUntil && r.hiddenAt === null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
