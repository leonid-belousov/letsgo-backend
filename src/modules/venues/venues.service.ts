import { Injectable } from '@nestjs/common';
import { Prisma, type Pitch, type Venue, type VenueStatus } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
  type PageQuery,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { bookingStep, parseStoredOpeningHours } from '../bookings/booking-rules';
import { isValidTimeZone } from '../bookings/time-zone';
import {
  BookingRulesDto,
  CreatePitchDto,
  CreateVenueDto,
  DEFAULT_VENUE_TIMEZONE,
  PitchDto,
  UpdatePitchDto,
  UpdateVenueDto,
  VenueDetailDto,
  VenueDto,
  VenueListQuery,
  VenuePageDto,
  WHOLE_PITCH,
} from './dto';
import { VenueAccess, accessDenied, notAvailable } from './venue-access';

type PitchFull = Prisma.PitchGetPayload<{
  include: { parts: true; configurations: { include: { parts: true } }; rules: true; terms: true };
}>;

const pitchInclude = {
  parts: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  configurations: { include: { parts: true }, orderBy: { id: 'asc' } },
  rules: true,
  terms: { orderBy: { version: 'desc' }, take: 1 },
} satisfies Prisma.PitchInclude;

export const COMMUNITY_MARKER = 'system:community-submission';

export function num(d: Prisma.Decimal | null): number | null {
  return d === null ? null : d.toNumber();
}

export function assertTimezone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw new ApiError(ErrorCode.VALIDATION, 'Unknown timezone.', { field: 'timezone' });
  }
}

export function assertGeo(lat: number | undefined, lng: number | undefined): void {
  if ((lat === undefined) !== (lng === undefined)) {
    throw new ApiError(ErrorCode.VALIDATION, 'Latitude and longitude go together.', {
      field: 'latitude',
    });
  }
}

/** Catalog reads (public) and venue / pitch management (staff and managers). */
@Injectable()
export class VenuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: VenueAccess,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── catalog ─────────────

  async list(q: VenueListQuery): Promise<VenuePageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const and: Prisma.VenueWhereInput[] = [{ status: 'PUBLISHED' }];
    if (q.city) and.push({ city: { equals: q.city, mode: 'insensitive' } });
    if (q.kind) and.push({ kind: q.kind });
    if (q.q) {
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { nameLocal: { contains: q.q, mode: 'insensitive' } },
          { address: { contains: q.q, mode: 'insensitive' } },
          { district: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    }
    const pitchFilter: Prisma.PitchWhereInput = { status: 'PUBLISHED' };
    if (q.surface) pitchFilter.surface = q.surface;
    if (q.setting) pitchFilter.setting = q.setting;
    if (q.format) pitchFilter.formats = { has: q.format };
    if (q.surface || q.setting || q.format) and.push({ pitches: { some: pitchFilter } });
    return this.page(and, cursor, limit, () => Promise.resolve(false));
  }

  /** Venues the caller manages or staffs, drafts included. */
  async managed(userId: string, page: PageQuery): Promise<VenuePageDto> {
    const scope = await this.access.managedScope(userId);
    const cursor = decodeCursor(page.cursor);
    const ids = new Set([...scope.venueIds, ...scope.pitchVenueIds]);
    const and: Prisma.VenueWhereInput[] = scope.all ? [] : [{ id: { in: [...ids] } }];
    return this.page(and, cursor, clampPageSize(page.limit), (v) =>
      this.access.canManageVenue(userId, v.id),
    );
  }

  private async page(
    and: Prisma.VenueWhereInput[],
    cursor: ReturnType<typeof decodeCursor>,
    limit: number,
    showVersion: (v: Venue) => Promise<boolean>,
  ): Promise<VenuePageDto> {
    const rows = await this.prisma.venue.findMany({
      where: { AND: and, ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { _count: { select: { pitches: { where: { status: 'PUBLISHED' } } } } },
    });
    const res = toPage(rows, limit, (v) => ({ t: v.createdAt.toISOString(), id: v.id }));
    const photos = await this.photosFor(
      this.prisma,
      res.items.map((v) => v.id),
    );
    const items: VenueDto[] = [];
    for (const v of res.items) {
      items.push(this.venueDto(v, photos.get(v.id) ?? [], v._count.pitches, await showVersion(v)));
    }
    return { items, nextCursor: res.nextCursor };
  }

  venueDetail(viewerId: string | null, venueId: string): Promise<VenueDetailDto> {
    return this.detail(this.prisma, viewerId, venueId);
  }

  async detail(db: Db, viewerId: string | null, venueId: string): Promise<VenueDetailDto> {
    const venue = await db.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw notAvailable();
    const scope = await this.access.managedScope(viewerId, db);
    if (venue.status !== 'PUBLISHED' && !this.access.canSeeVenue(scope, venue.id)) {
      throw notAvailable();
    }
    const pitches = await db.pitch.findMany({
      where: { venueId },
      include: pitchInclude,
      orderBy: { id: 'asc' },
    });
    const visible = pitches.filter(
      (p) => p.status === 'PUBLISHED' || this.access.canSeePitch(scope, p),
    );
    const canEdit = viewerId ? await this.access.canManageVenue(viewerId, venueId, db) : false;
    const canPublish = viewerId ? await this.access.canPublishVenue(viewerId, venueId, db) : false;
    const photos = await this.photosFor(db, [venueId]);
    const pitchDtos: PitchDto[] = [];
    for (const p of visible) pitchDtos.push(await this.pitchDto(db, viewerId, venue, p));
    return {
      ...this.venueDto(venue, photos.get(venueId) ?? [], visible.length, canEdit),
      pitches: pitchDtos,
      capabilities: { canEdit, canPublish, canCreatePitch: canEdit },
    };
  }

  async pitchDetail(viewerId: string | null, pitchId: string): Promise<PitchDto> {
    const pitch = await this.prisma.pitch.findUnique({
      where: { id: pitchId },
      include: { ...pitchInclude, venue: true },
    });
    if (!pitch) throw notAvailable();
    const scope = await this.access.managedScope(viewerId);
    const visible =
      (pitch.status === 'PUBLISHED' && pitch.venue.status === 'PUBLISHED') ||
      this.access.canSeePitch(scope, pitch);
    if (!visible) throw notAvailable();
    return this.pitchDto(this.prisma, viewerId, pitch.venue, pitch);
  }

  // ───────────── mapping ─────────────

  async photosFor(db: Db, venueIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (venueIds.length === 0) return out;
    const rows = await db.venueRequest.findMany({
      where: { resultingVenueId: { in: venueIds }, status: 'APPROVED' },
      orderBy: { createdAt: 'asc' },
      select: { resultingVenueId: true, photoMediaIds: true },
    });
    for (const r of rows) {
      if (r.resultingVenueId && !out.has(r.resultingVenueId)) {
        out.set(r.resultingVenueId, r.photoMediaIds);
      }
    }
    return out;
  }

  venueDto(
    venue: Venue,
    photoMediaIds: string[],
    pitchCount: number,
    withVersion: boolean,
  ): VenueDto {
    const dto: VenueDto = {
      id: venue.id,
      name: venue.name,
      nameLocal: venue.nameLocal,
      kind: venue.kind,
      status: venue.status,
      city: venue.city,
      district: venue.district,
      address: venue.address,
      latitude: num(venue.latitude),
      longitude: num(venue.longitude),
      timezone: venue.timezone,
      about: venue.about,
      photoMediaIds,
      pitchCount,
      publishedAt: venue.publishedAt ? venue.publishedAt.toISOString() : null,
    };
    if (withVersion) dto.version = venue.version;
    return dto;
  }

  async pitchDto(db: Db, viewerId: string | null, venue: Venue, p: PitchFull): Promise<PitchDto> {
    const canEdit = viewerId ? await this.access.canManagePitch(viewerId, p.id, db) : false;
    const canBookings = viewerId ? await this.access.isPitchStaff(viewerId, p.id, db) : false;
    const rules: BookingRulesDto | null = p.rules
      ? {
          minDurationMinutes: p.rules.minDurationMinutes,
          gridMinutes: p.rules.gridMinutes,
          allowHalfHourExtension: p.rules.allowHalfHourExtension,
          stepMinutes: bookingStep(p.rules),
          openingHours: parseStoredOpeningHours(
            p.rules.openingHours,
          ) as BookingRulesDto['openingHours'],
          ruleVersion: p.rules.ruleVersion,
        }
      : null;
    const terms = p.terms[0];
    const dto: PitchDto = {
      id: p.id,
      venueId: p.venueId,
      name: p.name,
      surface: p.surface,
      setting: p.setting,
      lengthM: num(p.lengthM),
      widthM: num(p.widthM),
      formats: p.formats,
      amenities: p.amenities,
      pricePerHourMinor: p.pricePerHourMinor,
      currency: p.currency,
      status: p.status,
      bookable: venue.kind === 'PAID' && venue.status === 'PUBLISHED' && p.status === 'PUBLISHED',
      parts: p.parts.map((x) => ({ id: x.id, name: x.name, sortOrder: x.sortOrder })),
      configurations: p.configurations.map((c) => ({
        id: c.id,
        name: c.name,
        format: c.format,
        partIds: c.parts.map((x) => x.partId).sort(),
      })),
      bookingRules: rules,
      latestTerms: terms
        ? { version: terms.version, body: terms.body, createdAt: terms.createdAt.toISOString() }
        : null,
      capabilities: { canEdit, canPublish: canEdit, canManageBookings: canBookings },
    };
    if (canEdit) dto.version = p.version;
    return dto;
  }

  // ───────────── venue management ─────────────

  async createVenue(
    actorId: string,
    dto: CreateVenueDto,
    requestId: string,
  ): Promise<VenueDetailDto> {
    if (!(await this.access.isCatalogAdmin(actorId))) throw accessDenied();
    assertGeo(dto.latitude, dto.longitude);
    const timezone = dto.timezone ?? DEFAULT_VENUE_TIMEZONE;
    assertTimezone(timezone);
    return this.prisma.$transaction(async (tx) => {
      const venue = await tx.venue.create({
        data: {
          name: dto.name,
          nameLocal: dto.nameLocal ?? null,
          kind: 'PAID',
          status: 'DRAFT',
          city: dto.city,
          district: dto.district ?? null,
          address: dto.address ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          timezone,
          about: dto.about ?? null,
          createdById: actorId,
        },
      });
      await this.audit.record(tx, {
        actorId,
        action: 'venue.create',
        targetType: 'VENUE',
        targetId: venue.id,
        metadata: { name: venue.name, city: venue.city },
        requestId,
      });
      return this.detail(tx, actorId, venue.id);
    });
  }

  async updateVenue(
    actorId: string,
    venueId: string,
    dto: UpdateVenueDto,
    requestId: string,
  ): Promise<VenueDetailDto> {
    if (dto.timezone !== undefined) assertTimezone(dto.timezone);
    assertGeo(dto.latitude, dto.longitude);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId}::uuid FOR UPDATE`;
      const venue = await this.venueOrThrow(tx, actorId, venueId);
      await this.assertManageVenue(tx, actorId, venue);
      this.assertVersion(dto.version, venue.version);
      const data: Prisma.VenueUpdateInput = { version: { increment: 1 } };
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.nameLocal !== undefined) data.nameLocal = dto.nameLocal;
      if (dto.city !== undefined) data.city = dto.city;
      if (dto.district !== undefined) data.district = dto.district;
      if (dto.address !== undefined) data.address = dto.address;
      if (dto.about !== undefined) data.about = dto.about;
      if (dto.timezone !== undefined) data.timezone = dto.timezone;
      if (dto.latitude !== undefined) data.latitude = dto.latitude;
      if (dto.longitude !== undefined) data.longitude = dto.longitude;
      await tx.venue.update({ where: { id: venueId }, data });
      await this.audit.record(tx, {
        actorId,
        action: 'venue.update',
        targetType: 'VENUE',
        targetId: venueId,
        metadata: { fields: Object.keys(dto).filter((k) => k !== 'version') },
        requestId,
      });
      return this.detail(tx, actorId, venueId);
    });
  }

  async setVenueStatus(
    actorId: string,
    venueId: string,
    status: Extract<VenueStatus, 'PUBLISHED' | 'HIDDEN'>,
    requestId: string,
  ): Promise<VenueDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId}::uuid FOR UPDATE`;
      const venue = await this.venueOrThrow(tx, actorId, venueId);
      if (!(await this.access.canPublishVenue(actorId, venueId, tx))) {
        await this.denyOrHide(tx, actorId, venue);
      }
      if (venue.status !== status) {
        await tx.venue.update({
          where: { id: venueId },
          data: {
            status,
            version: { increment: 1 },
            ...(status === 'PUBLISHED' && !venue.publishedAt
              ? { publishedAt: this.clock.now() }
              : {}),
          },
        });
        if (status === 'PUBLISHED') await this.makePhotosPublic(tx, venueId);
        await this.audit.record(tx, {
          actorId,
          action: status === 'PUBLISHED' ? 'venue.publish' : 'venue.hide',
          targetType: 'VENUE',
          targetId: venueId,
          metadata: { from: venue.status },
          requestId,
        });
      }
      return this.detail(tx, actorId, venueId);
    });
  }

  /** Photos of a published venue are shown to everybody. */
  async makePhotosPublic(tx: Tx, venueId: string): Promise<void> {
    const req = await tx.venueRequest.findMany({
      where: { resultingVenueId: venueId, status: 'APPROVED' },
      select: { photoMediaIds: true },
    });
    const ids = req.flatMap((r) => r.photoMediaIds);
    if (ids.length > 0) {
      await tx.mediaAsset.updateMany({
        where: { id: { in: ids } },
        data: { visibility: 'PUBLIC' },
      });
    }
  }

  // ───────────── pitch management ─────────────

  async createPitch(
    actorId: string,
    venueId: string,
    dto: CreatePitchDto,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      const venue = await this.venueOrThrow(tx, actorId, venueId);
      await this.assertManageVenue(tx, actorId, venue);
      const pitch = await this.createPitchWithDefaults(tx, venueId, dto, 'DRAFT');
      await this.audit.record(tx, {
        actorId,
        action: 'pitch.create',
        targetType: 'PITCH',
        targetId: pitch.id,
        metadata: { venueId },
        requestId,
      });
      return this.pitchDtoById(tx, actorId, pitch.id);
    });
  }

  /**
   * Every pitch has ≥ 1 atomic part, a default “Whole pitch” configuration covering all parts
   * and a BookingRules row (defaults: min 60, grid 30, extension off).
   */
  async createPitchWithDefaults(
    tx: Tx,
    venueId: string,
    input: Partial<CreatePitchDto> & { name: string },
    status: VenueStatus,
  ): Promise<Pitch> {
    const partNames = input.partNames?.length ? input.partNames : [WHOLE_PITCH];
    const pitch = await tx.pitch.create({
      data: {
        venueId,
        name: input.name,
        surface: input.surface ?? null,
        setting: input.setting ?? null,
        lengthM: input.lengthM ?? null,
        widthM: input.widthM ?? null,
        formats: input.formats ?? [],
        amenities: input.amenities ?? [],
        pricePerHourMinor: input.pricePerHourMinor ?? null,
        currency: input.currency ?? 'GEL',
        status,
      },
    });
    const parts = [];
    for (const [i, name] of partNames.entries()) {
      parts.push(await tx.pitchPart.create({ data: { pitchId: pitch.id, name, sortOrder: i } }));
    }
    const whole = await tx.pitchConfiguration.create({
      data: { pitchId: pitch.id, name: WHOLE_PITCH },
    });
    await tx.pitchConfigurationPart.createMany({
      data: parts.map((p) => ({ configurationId: whole.id, partId: p.id })),
    });
    await tx.bookingRules.create({ data: { pitchId: pitch.id } });
    return pitch;
  }

  async updatePitch(
    actorId: string,
    pitchId: string,
    dto: UpdatePitchDto,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Pitch" WHERE id = ${pitchId}::uuid FOR UPDATE`;
      const pitch = await this.pitchOrThrow(tx, actorId, pitchId);
      await this.assertManagePitch(tx, actorId, pitch);
      this.assertVersion(dto.version, pitch.version);
      const data: Prisma.PitchUpdateInput = { version: { increment: 1 } };
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.surface !== undefined) data.surface = dto.surface;
      if (dto.setting !== undefined) data.setting = dto.setting;
      if (dto.lengthM !== undefined) data.lengthM = dto.lengthM;
      if (dto.widthM !== undefined) data.widthM = dto.widthM;
      if (dto.formats !== undefined) data.formats = dto.formats;
      if (dto.amenities !== undefined) data.amenities = dto.amenities;
      if (dto.pricePerHourMinor !== undefined) data.pricePerHourMinor = dto.pricePerHourMinor;
      if (dto.currency !== undefined) data.currency = dto.currency;
      await tx.pitch.update({ where: { id: pitchId }, data });
      await this.audit.record(tx, {
        actorId,
        action: 'pitch.update',
        targetType: 'PITCH',
        targetId: pitchId,
        metadata: { fields: Object.keys(dto).filter((k) => k !== 'version') },
        requestId,
      });
      return this.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async setPitchStatus(
    actorId: string,
    pitchId: string,
    status: Extract<VenueStatus, 'PUBLISHED' | 'HIDDEN'>,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Pitch" WHERE id = ${pitchId}::uuid FOR UPDATE`;
      const pitch = await this.pitchOrThrow(tx, actorId, pitchId);
      await this.assertManagePitch(tx, actorId, pitch);
      if (pitch.status !== status) {
        await tx.pitch.update({
          where: { id: pitchId },
          data: { status, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          actorId,
          action: status === 'PUBLISHED' ? 'pitch.publish' : 'pitch.hide',
          targetType: 'PITCH',
          targetId: pitchId,
          metadata: { from: pitch.status },
          requestId,
        });
      }
      return this.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async pitchDtoById(db: Db, viewerId: string | null, pitchId: string): Promise<PitchDto> {
    const p = await db.pitch.findUniqueOrThrow({
      where: { id: pitchId },
      include: { ...pitchInclude, venue: true },
    });
    return this.pitchDto(db, viewerId, p.venue, p);
  }

  // ───────────── guards ─────────────

  /** Loads a venue the actor may at least know about (NOT_FOUND otherwise). */
  async venueOrThrow(db: Db, actorId: string | null, venueId: string): Promise<Venue> {
    const venue = await db.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw notAvailable();
    if (venue.status !== 'PUBLISHED') {
      const scope = await this.access.managedScope(actorId, db);
      if (!this.access.canSeeVenue(scope, venueId)) throw notAvailable();
    }
    return venue;
  }

  async pitchOrThrow(
    db: Db,
    actorId: string | null,
    pitchId: string,
  ): Promise<Pitch & { venue: Venue }> {
    const pitch = await db.pitch.findUnique({ where: { id: pitchId }, include: { venue: true } });
    if (!pitch) throw notAvailable();
    if (pitch.status !== 'PUBLISHED' || pitch.venue.status !== 'PUBLISHED') {
      const scope = await this.access.managedScope(actorId, db);
      if (!this.access.canSeePitch(scope, pitch)) throw notAvailable();
    }
    return pitch;
  }

  async assertManageVenue(db: Db, actorId: string, venue: Venue): Promise<void> {
    if (!(await this.access.canManageVenue(actorId, venue.id, db))) {
      await this.denyOrHide(db, actorId, venue);
    }
  }

  async assertManagePitch(
    db: Db,
    actorId: string,
    pitch: Pitch & { venue?: Venue },
  ): Promise<void> {
    if (!(await this.access.canManagePitch(actorId, pitch.id, db))) {
      const venue =
        pitch.venue ?? (await db.venue.findUniqueOrThrow({ where: { id: pitch.venueId } }));
      await this.denyOrHide(db, actorId, venue);
    }
  }

  /** Published things are known to everyone (ACCESS_DENIED); drafts do not exist for outsiders. */
  private async denyOrHide(db: Db, actorId: string, venue: Venue): Promise<never> {
    if (venue.status === 'PUBLISHED') throw accessDenied();
    const scope = await this.access.managedScope(actorId, db);
    if (this.access.canSeeVenue(scope, venue.id)) throw accessDenied();
    throw notAvailable();
  }

  assertVersion(sent: number, current: number): void {
    if (sent !== current) {
      throw new ApiError(ErrorCode.VERSION_CHANGED, 'This was changed elsewhere.', {
        currentVersion: current,
      });
    }
  }
}
