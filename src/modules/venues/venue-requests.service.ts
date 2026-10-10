import { Injectable } from '@nestjs/common';
import type { Venue, VenueRequest } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
  type PageQuery,
} from '../../common/pagination/cursor-page';
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AdminVenueRequestDto,
  AdminVenueRequestPageDto,
  AdminVenueRequestQuery,
  ApproveVenueRequestDto,
  CommunityPitchDto,
  CommunityPitchResultDto,
  CreateVenueRequestDto,
  DEFAULT_VENUE_TIMEZONE,
  MyVenueRequestDto,
  MyVenueRequestPageDto,
  RespondVenueRequestDto,
  VenueRequestMessageDto,
} from './dto';
import { VenueAccess, accessDenied, notAvailable } from './venue-access';
import { assertGeo, assertTimezone, COMMUNITY_MARKER, num, VenuesService } from './venues.service';

const MAX_OPEN_REQUESTS = 10;
const DUPLICATE_RADIUS_M = 50;
const OPEN_STATUSES = ['PENDING', 'NEEDS_INFO'] as const;

/** Rows created by community submissions only keep the photos; they are not user requests. */
const notCommunityMarker = {
  OR: [{ staffNote: null }, { staffNote: { not: COMMUNITY_MARKER } }],
};

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

@Injectable()
export class VenueRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly access: VenueAccess,
    private readonly venues: VenuesService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  // ───────────── community pitch ─────────────

  /**
   * A free public pitch added by any person with a complete profile. It is published at once
   * (kind COMMUNITY); the contributor is *not* its owner or manager — later edits go through
   * Let’sGo staff. A likely duplicate returns the existing venue instead.
   */
  async submitCommunity(
    userId: string,
    dto: CommunityPitchDto,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<CommunityPitchResultDto> {
    if (dto.confirmedFreePublic !== true) {
      throw new ApiError(ErrorCode.VALIDATION, 'Confirm that this is a free public pitch.', {
        field: 'confirmedFreePublic',
      });
    }
    const timezone = dto.timezone ?? DEFAULT_VENUE_TIMEZONE;
    assertTimezone(timezone);
    await this.requireCompleteProfile(this.prisma, userId);
    return this.idempotency.execute(
      { userId, scope: 'venues.community', key: idempotencyKey, payload: dto },
      async (tx) => {
        await this.assertOwnPhotos(tx, userId, dto.photoMediaIds);
        // Serialise submissions per city so two identical submissions cannot both pass the check.
        const lockKey = `community:${dto.city.toLowerCase()}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const duplicate = await this.findDuplicate(tx, dto);
        if (duplicate) {
          return {
            created: false,
            duplicateOf: duplicate.id,
            venue: await this.venues.detail(tx, userId, duplicate.id),
          };
        }
        const now = this.clock.now();
        const venue = await tx.venue.create({
          data: {
            name: dto.name,
            kind: 'COMMUNITY',
            status: 'PUBLISHED',
            publishedAt: now,
            city: dto.city,
            address: dto.address ?? null,
            latitude: dto.latitude,
            longitude: dto.longitude,
            timezone,
            about: dto.about ?? null,
            createdById: userId,
          },
        });
        await this.venues.createPitchWithDefaults(
          tx,
          venue.id,
          { name: dto.name, surface: dto.surface, setting: dto.setting },
          'PUBLISHED',
        );
        // Photo evidence lives with the submission record (staff-invisible marker note).
        await tx.venueRequest.create({
          data: {
            requestedById: userId,
            name: dto.name,
            city: dto.city,
            latitude: dto.latitude,
            longitude: dto.longitude,
            address: dto.address ?? null,
            photoMediaIds: dto.photoMediaIds,
            status: 'APPROVED',
            staffNote: COMMUNITY_MARKER,
            resultingVenueId: venue.id,
            reviewedAt: now,
          },
        });
        await tx.mediaAsset.updateMany({
          where: { id: { in: dto.photoMediaIds } },
          data: { visibility: 'PUBLIC' },
        });
        await this.audit.record(tx, {
          actorId: userId,
          action: 'venue.community.create',
          targetType: 'VENUE',
          targetId: venue.id,
          metadata: { city: venue.city },
          requestId,
        });
        return {
          created: true,
          duplicateOf: null,
          venue: await this.venues.detail(tx, userId, venue.id),
        };
      },
    );
  }

  private async findDuplicate(tx: Tx, dto: CommunityPitchDto): Promise<Venue | null> {
    const sameName = await tx.venue.findFirst({
      where: {
        status: 'PUBLISHED',
        name: { equals: dto.name, mode: 'insensitive' },
        city: { equals: dto.city, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (sameName) return sameName;
    const dLat = 0.001; // ≈ 111 m
    const dLon = dLat / Math.max(Math.cos((dto.latitude * Math.PI) / 180), 0.01);
    const near = await tx.venue.findMany({
      where: {
        status: 'PUBLISHED',
        latitude: { gte: dto.latitude - dLat, lte: dto.latitude + dLat },
        longitude: { gte: dto.longitude - dLon, lte: dto.longitude + dLon },
      },
      orderBy: { createdAt: 'asc' },
    });
    return (
      near.find(
        (v) =>
          haversineM(dto.latitude, dto.longitude, num(v.latitude) ?? 0, num(v.longitude) ?? 0) <=
          DUPLICATE_RADIUS_M,
      ) ?? null
    );
  }

  // ───────────── paid pitch requests (user side) ─────────────

  async createRequest(
    userId: string,
    dto: CreateVenueRequestDto,
    idempotencyKey: string | undefined,
  ): Promise<MyVenueRequestDto> {
    assertGeo(dto.latitude, dto.longitude);
    if (!dto.address && dto.latitude === undefined) {
      throw new ApiError(ErrorCode.VALIDATION, 'Give an address or a map point.', {
        field: 'address',
      });
    }
    await this.requireCompleteProfile(this.prisma, userId);
    return this.idempotency.execute(
      { userId, scope: 'venues.request', key: idempotencyKey, payload: dto },
      async (tx) => {
        await this.assertOwnPhotos(tx, userId, dto.photoMediaIds);
        const open = await tx.venueRequest.count({
          where: {
            requestedById: userId,
            status: { in: [...OPEN_STATUSES] },
            ...notCommunityMarker,
          },
        });
        if (open >= MAX_OPEN_REQUESTS) {
          throw new ApiError(ErrorCode.CONFLICT, 'You have too many open requests.', {
            reason: 'REQUEST_LIMIT',
          });
        }
        const row = await tx.venueRequest.create({
          data: {
            requestedById: userId,
            name: dto.name,
            city: dto.city,
            address: dto.address ?? null,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            comment: dto.comment ?? null,
            photoMediaIds: dto.photoMediaIds,
          },
        });
        return this.myDto(row, null);
      },
    );
  }

  async listMine(userId: string, page: PageQuery): Promise<MyVenueRequestPageDto> {
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.venueRequest.findMany({
      where: { requestedById: userId, ...notCommunityMarker, ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    const published = await this.publishedVenueIds(res.items);
    return { items: res.items.map((r) => this.myDto(r, published)), nextCursor: res.nextCursor };
  }

  async getMine(userId: string, id: string): Promise<MyVenueRequestDto> {
    const row = await this.prisma.venueRequest.findFirst({
      where: { id, requestedById: userId, ...notCommunityMarker },
    });
    if (!row) throw notAvailable();
    return this.myDto(row, await this.publishedVenueIds([row]));
  }

  /** The requester answers a “more info needed” message; the request returns to the queue. */
  async respond(
    userId: string,
    id: string,
    dto: RespondVenueRequestDto,
  ): Promise<MyVenueRequestDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "VenueRequest" WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.venueRequest.findFirst({
        where: { id, requestedById: userId, ...notCommunityMarker },
      });
      if (!row) throw notAvailable();
      if (row.status !== 'NEEDS_INFO') {
        throw new ApiError(ErrorCode.CONFLICT, 'Nothing is being asked for on this request.');
      }
      if (dto.photoMediaIds) await this.assertOwnPhotos(tx, userId, dto.photoMediaIds);
      const updated = await tx.venueRequest.update({
        where: { id },
        data: {
          status: 'PENDING',
          comment: dto.comment ?? row.comment,
          photoMediaIds: dto.photoMediaIds ?? row.photoMediaIds,
        },
      });
      return this.myDto(updated, null);
    });
  }

  private async publishedVenueIds(rows: VenueRequest[]): Promise<Set<string>> {
    const ids = rows.flatMap((r) => (r.resultingVenueId ? [r.resultingVenueId] : []));
    if (ids.length === 0) return new Set();
    const venues = await this.prisma.venue.findMany({
      where: { id: { in: ids }, status: 'PUBLISHED' },
      select: { id: true },
    });
    return new Set(venues.map((v) => v.id));
  }

  private myDto(r: VenueRequest, publishedVenues: Set<string> | null): MyVenueRequestDto {
    const answered = r.status === 'NEEDS_INFO' || r.status === 'DECLINED';
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      address: r.address,
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      comment: r.comment,
      photoMediaIds: r.photoMediaIds,
      status: r.status,
      from: 'Let’sGo',
      message: answered ? r.staffNote : null,
      venueId:
        r.resultingVenueId && publishedVenues?.has(r.resultingVenueId) ? r.resultingVenueId : null,
      createdAt: r.createdAt.toISOString(),
      answeredAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    };
  }

  // ───────────── staff side ─────────────

  private async assertReviewer(userId: string, db: Db = this.prisma): Promise<void> {
    if (
      !(await this.policy.can(userId, Permission.ADMIN_VENUE_REQUESTS, { type: 'PLATFORM' }, db))
    ) {
      throw accessDenied();
    }
  }

  async adminList(userId: string, q: AdminVenueRequestQuery): Promise<AdminVenueRequestPageDto> {
    await this.assertReviewer(userId);
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.venueRequest.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...notCommunityMarker,
        ...keysetBefore('createdAt', cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return { items: await this.adminDtos(this.prisma, res.items), nextCursor: res.nextCursor };
  }

  async adminGet(userId: string, id: string): Promise<AdminVenueRequestDto> {
    await this.assertReviewer(userId);
    const row = await this.prisma.venueRequest.findFirst({ where: { id, ...notCommunityMarker } });
    if (!row) throw notAvailable();
    return (await this.adminDtos(this.prisma, [row]))[0] as AdminVenueRequestDto;
  }

  async approve(
    reviewerId: string,
    id: string,
    dto: ApproveVenueRequestDto,
    requestId: string,
  ): Promise<AdminVenueRequestDto> {
    await this.assertReviewer(reviewerId);
    const publish = dto.publish === true;
    if (publish && !(await this.access.isCatalogAdmin(reviewerId))) throw accessDenied();
    const timezone = dto.timezone ?? DEFAULT_VENUE_TIMEZONE;
    assertTimezone(timezone);
    return this.prisma.$transaction(async (tx) => {
      const req = await this.lockOpen(tx, id);
      const now = this.clock.now();
      const venue = await tx.venue.create({
        data: {
          name: req.name,
          kind: 'PAID',
          status: publish ? 'PUBLISHED' : 'DRAFT',
          publishedAt: publish ? now : null,
          city: req.city,
          address: req.address,
          latitude: req.latitude,
          longitude: req.longitude,
          timezone,
          createdById: reviewerId,
        },
      });
      await this.venues.createPitchWithDefaults(
        tx,
        venue.id,
        { name: dto.pitchName ?? req.name },
        publish ? 'PUBLISHED' : 'DRAFT',
      );
      const updated = await tx.venueRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: reviewerId,
          reviewedAt: now,
          resultingVenueId: venue.id,
          staffNote: dto.note ?? req.staffNote,
        },
      });
      if (publish) await this.venues.makePhotosPublic(tx, venue.id);
      await this.audit.record(tx, {
        actorId: reviewerId,
        action: 'venue.request.approve',
        targetType: 'VENUE_REQUEST',
        targetId: id,
        metadata: { venueId: venue.id, published: publish },
        requestId,
      });
      await this.notifyRequester(tx, updated, 'approved', 'Your pitch request was approved');
      return (await this.adminDtos(tx, [updated]))[0] as AdminVenueRequestDto;
    });
  }

  async requestMoreInfo(
    reviewerId: string,
    id: string,
    dto: VenueRequestMessageDto,
    requestId: string,
  ): Promise<AdminVenueRequestDto> {
    return this.answer(
      reviewerId,
      id,
      'NEEDS_INFO',
      dto.message,
      requestId,
      'venue.request.needs_info',
    );
  }

  async decline(
    reviewerId: string,
    id: string,
    dto: VenueRequestMessageDto,
    requestId: string,
  ): Promise<AdminVenueRequestDto> {
    return this.answer(reviewerId, id, 'DECLINED', dto.message, requestId, 'venue.request.decline');
  }

  private async answer(
    reviewerId: string,
    id: string,
    status: 'NEEDS_INFO' | 'DECLINED',
    message: string,
    requestId: string,
    action: string,
  ): Promise<AdminVenueRequestDto> {
    await this.assertReviewer(reviewerId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOpen(tx, id);
      const updated = await tx.venueRequest.update({
        where: { id },
        data: {
          status,
          staffNote: message,
          reviewedById: reviewerId,
          reviewedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        actorId: reviewerId,
        action,
        targetType: 'VENUE_REQUEST',
        targetId: id,
        metadata: { status },
        requestId,
      });
      await this.notifyRequester(
        tx,
        updated,
        status === 'DECLINED' ? 'declined' : 'needs_info',
        status === 'DECLINED'
          ? 'Your pitch request was declined'
          : 'Let’sGo needs more information about your pitch request',
      );
      return (await this.adminDtos(tx, [updated]))[0] as AdminVenueRequestDto;
    });
  }

  private async lockOpen(tx: Tx, id: string): Promise<VenueRequest> {
    await tx.$queryRaw`SELECT id FROM "VenueRequest" WHERE id = ${id}::uuid FOR UPDATE`;
    const req = await tx.venueRequest.findFirst({ where: { id, ...notCommunityMarker } });
    if (!req) throw notAvailable();
    if (!(OPEN_STATUSES as readonly string[]).includes(req.status)) {
      throw new ApiError(ErrorCode.CONFLICT, 'This request has already been decided.', {
        reason: 'REQUEST_CLOSED',
      });
    }
    return req;
  }

  private async notifyRequester(
    tx: Tx,
    req: VenueRequest,
    what: string,
    title: string,
  ): Promise<void> {
    await this.notifier.notify(tx, {
      recipientIds: [req.requestedById],
      category: 'system',
      activityKind: `venue.request_${what}`,
      title,
      objectType: 'VENUE_REQUEST',
      objectId: req.id,
      payload: { requestId: req.id },
      dedupeKey: `venue-request:${req.id}:${what}:${this.clock.now().getTime()}`,
      essential: true,
    });
  }

  private async adminDtos(db: Db, rows: VenueRequest[]): Promise<AdminVenueRequestDto[]> {
    const profiles = await db.profile.findMany({
      where: { userId: { in: rows.map((r) => r.requestedById) } },
      select: { userId: true, nickname: true, username: true },
    });
    const by = new Map(profiles.map((p) => [p.userId, p]));
    const venueIds = rows.flatMap((r) => (r.resultingVenueId ? [r.resultingVenueId] : []));
    const published = new Set(
      (
        await db.venue.findMany({
          where: { id: { in: venueIds }, status: 'PUBLISHED' },
          select: { id: true },
        })
      ).map((v) => v.id),
    );
    return rows.map((r) => ({
      ...this.myDto(r, published),
      // Staff see their own note whatever the status.
      message: r.staffNote,
      requestedById: r.requestedById,
      requesterNickname: by.get(r.requestedById)?.nickname ?? null,
      requesterUsername: by.get(r.requestedById)?.username ?? null,
      reviewedById: r.reviewedById,
      resultingVenueId: r.resultingVenueId,
    }));
  }

  // ───────────── helpers ─────────────

  private async requireCompleteProfile(db: Db, userId: string): Promise<void> {
    const profile = await db.profile.findUnique({
      where: { userId },
      select: { completedAt: true },
    });
    if (!profile?.completedAt) {
      throw new ApiError(ErrorCode.VALIDATION, 'Complete your profile first.', {
        field: 'profile',
      });
    }
  }

  private async assertOwnPhotos(db: Db, userId: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const assets = await db.mediaAsset.findMany({
      where: { id: { in: unique } },
      select: { id: true, ownerId: true, status: true, kind: true },
    });
    const ok =
      assets.length === unique.length &&
      assets.every((a) => a.ownerId === userId && a.status === 'READY' && a.kind === 'PHOTO');
    if (!ok) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        'Photos must be your own uploaded photos that finished processing.',
        { field: 'photoMediaIds' },
      );
    }
  }
}
