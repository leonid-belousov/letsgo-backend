import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { normalizeOpeningHours } from '../bookings/booking-rules';
import {
  BookingTermsDto,
  ConfigurationInputDto,
  CreateTermsDto,
  PitchDto,
  PutBookingRulesDto,
  TermsListDto,
  UpdateConfigurationDto,
  WHOLE_PITCH,
} from './dto';
import { notAvailable } from './venue-access';
import { VenuesService } from './venues.service';

const MAX_PARTS = 8;
const MAX_CONFIGS = 24;

/**
 * Pitch anatomy and booking policy: parts, bookable configurations, booking rules (each change
 * bumps `ruleVersion`; existing bookings keep theirs) and append-only booking terms.
 * Every mutation locks the Pitch row so bookings (which take a shared lock) never observe a
 * half-changed pitch.
 */
@Injectable()
export class PitchStructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly venues: VenuesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async begin(tx: Tx, actorId: string, pitchId: string) {
    await tx.$queryRaw`SELECT id FROM "Pitch" WHERE id = ${pitchId}::uuid FOR UPDATE`;
    const pitch = await this.venues.pitchOrThrow(tx, actorId, pitchId);
    await this.venues.assertManagePitch(tx, actorId, pitch);
    return pitch;
  }

  private conflict(message: string, reason: string): ApiError {
    return new ApiError(ErrorCode.CONFLICT, message, { reason });
  }

  // ───────────── parts ─────────────

  async addPart(
    actorId: string,
    pitchId: string,
    name: string,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const parts = await tx.pitchPart.findMany({
        where: { pitchId },
        orderBy: { sortOrder: 'asc' },
      });
      if (parts.length >= MAX_PARTS) throw this.conflict('Too many parts.', 'PART_LIMIT');
      if (parts.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw this.conflict('A part with this name exists.', 'DUPLICATE_NAME');
      }
      const part = await tx.pitchPart.create({
        data: { pitchId, name, sortOrder: (parts[parts.length - 1]?.sortOrder ?? -1) + 1 },
      });
      // The default configuration always covers every part.
      const whole = await this.wholeConfig(tx, pitchId);
      if (whole) {
        await tx.pitchConfigurationPart.create({
          data: { configurationId: whole.id, partId: part.id },
        });
      }
      await this.record(tx, actorId, 'pitch.part.add', pitchId, { partId: part.id }, requestId);
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async renamePart(
    actorId: string,
    pitchId: string,
    partId: string,
    name: string,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const part = await tx.pitchPart.findFirst({ where: { id: partId, pitchId } });
      if (!part) throw notAvailable();
      const dup = await tx.pitchPart.findFirst({
        where: { pitchId, id: { not: partId }, name: { equals: name, mode: 'insensitive' } },
      });
      if (dup) throw this.conflict('A part with this name exists.', 'DUPLICATE_NAME');
      await tx.pitchPart.update({ where: { id: partId }, data: { name } });
      await this.record(tx, actorId, 'pitch.part.rename', pitchId, { partId }, requestId);
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async removePart(
    actorId: string,
    pitchId: string,
    partId: string,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const part = await tx.pitchPart.findFirst({ where: { id: partId, pitchId } });
      if (!part) throw notAvailable();
      if ((await tx.pitchPart.count({ where: { pitchId } })) <= 1) {
        throw this.conflict('A pitch always has at least one part.', 'LAST_PART');
      }
      if ((await tx.pitchOccupancy.count({ where: { partId } })) > 0) {
        throw this.conflict('This part has bookings or blocks on record.', 'PART_IN_USE');
      }
      const affected = await tx.pitchConfigurationPart.findMany({
        where: { partId },
        select: { configurationId: true },
      });
      await tx.pitchPart.delete({ where: { id: partId } });
      for (const { configurationId } of affected) {
        const left = await tx.pitchConfigurationPart.count({ where: { configurationId } });
        if (left === 0) {
          if ((await tx.booking.count({ where: { configurationId } })) > 0) {
            throw this.conflict(
              'A configuration with bookings would become empty.',
              'CONFIGURATION_IN_USE',
            );
          }
          await tx.pitchConfiguration.delete({ where: { id: configurationId } });
        }
      }
      await this.record(tx, actorId, 'pitch.part.remove', pitchId, { partId }, requestId);
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  // ───────────── configurations ─────────────

  async createConfiguration(
    actorId: string,
    pitchId: string,
    dto: ConfigurationInputDto,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const configs = await tx.pitchConfiguration.findMany({ where: { pitchId } });
      if (configs.length >= MAX_CONFIGS)
        throw this.conflict('Too many configurations.', 'CONFIG_LIMIT');
      this.assertUniqueName(configs, dto.name);
      await this.assertPartsBelong(tx, pitchId, dto.partIds);
      const config = await tx.pitchConfiguration.create({
        data: { pitchId, name: dto.name, format: dto.format ?? null },
      });
      await tx.pitchConfigurationPart.createMany({
        data: dto.partIds.map((partId) => ({ configurationId: config.id, partId })),
      });
      await this.record(
        tx,
        actorId,
        'pitch.config.create',
        pitchId,
        { configurationId: config.id },
        requestId,
      );
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async updateConfiguration(
    actorId: string,
    pitchId: string,
    configurationId: string,
    dto: UpdateConfigurationDto,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const config = await tx.pitchConfiguration.findFirst({
        where: { id: configurationId, pitchId },
        include: { parts: true },
      });
      if (!config) throw notAvailable();
      const isWhole = config.name.toLowerCase() === WHOLE_PITCH.toLowerCase();
      if (isWhole && (dto.name !== undefined || dto.partIds !== undefined)) {
        throw this.conflict(
          'The default “Whole pitch” configuration is fixed.',
          'DEFAULT_CONFIGURATION',
        );
      }
      if (dto.name !== undefined) {
        this.assertUniqueName(
          await tx.pitchConfiguration.findMany({
            where: { pitchId, id: { not: configurationId } },
          }),
          dto.name,
        );
      }
      if (dto.partIds !== undefined) {
        await this.assertPartsBelong(tx, pitchId, dto.partIds);
        // Never silently invalidate upcoming reservations.
        if (await this.hasActiveBookings(tx, configurationId)) {
          throw this.conflict(
            'This configuration has upcoming bookings; cancel or finish them first.',
            'CONFIGURATION_IN_USE',
          );
        }
        await tx.pitchConfigurationPart.deleteMany({ where: { configurationId } });
        await tx.pitchConfigurationPart.createMany({
          data: dto.partIds.map((partId) => ({ configurationId, partId })),
        });
      }
      const data: Prisma.PitchConfigurationUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.format !== undefined) data.format = dto.format;
      if (Object.keys(data).length > 0)
        await tx.pitchConfiguration.update({ where: { id: configurationId }, data });
      await this.record(
        tx,
        actorId,
        'pitch.config.update',
        pitchId,
        { configurationId },
        requestId,
      );
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  async deleteConfiguration(
    actorId: string,
    pitchId: string,
    configurationId: string,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const config = await tx.pitchConfiguration.findFirst({
        where: { id: configurationId, pitchId },
      });
      if (!config) throw notAvailable();
      if (config.name.toLowerCase() === WHOLE_PITCH.toLowerCase()) {
        throw this.conflict(
          'The default “Whole pitch” configuration cannot be removed.',
          'DEFAULT_CONFIGURATION',
        );
      }
      if ((await tx.booking.count({ where: { configurationId } })) > 0) {
        throw this.conflict('This configuration has bookings on record.', 'CONFIGURATION_IN_USE');
      }
      await tx.pitchConfiguration.delete({ where: { id: configurationId } });
      await this.record(
        tx,
        actorId,
        'pitch.config.delete',
        pitchId,
        { configurationId },
        requestId,
      );
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  private wholeConfig(tx: Tx, pitchId: string) {
    return tx.pitchConfiguration.findFirst({
      where: { pitchId, name: { equals: WHOLE_PITCH, mode: 'insensitive' } },
      orderBy: { id: 'asc' },
    });
  }

  private assertUniqueName(existing: { name: string }[], name: string): void {
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw this.conflict('A configuration with this name exists.', 'DUPLICATE_NAME');
    }
  }

  private async assertPartsBelong(tx: Tx, pitchId: string, partIds: string[]): Promise<void> {
    const found = await tx.pitchPart.count({ where: { pitchId, id: { in: partIds } } });
    if (found !== new Set(partIds).size) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown part for this pitch.', {
        field: 'partIds',
      });
    }
  }

  private async hasActiveBookings(tx: Tx, configurationId: string): Promise<boolean> {
    const n = await tx.booking.count({
      where: {
        configurationId,
        status: { in: ['REQUESTED', 'HELD', 'CONFIRMED'] },
        endsAt: { gt: this.clock.now() },
      },
    });
    return n > 0;
  }

  // ───────────── booking rules ─────────────

  async putRules(
    actorId: string,
    pitchId: string,
    dto: PutBookingRulesDto,
    requestId: string,
  ): Promise<PitchDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const current =
        (await tx.bookingRules.findUnique({ where: { pitchId } })) ??
        (await tx.bookingRules.create({ data: { pitchId } }));
      if (
        dto.expectedRuleVersion !== undefined &&
        dto.expectedRuleVersion !== current.ruleVersion
      ) {
        throw new ApiError(ErrorCode.VERSION_CHANGED, 'Booking rules were changed elsewhere.', {
          currentVersion: current.ruleVersion,
        });
      }
      const min = dto.minDurationMinutes ?? current.minDurationMinutes;
      const grid = dto.gridMinutes ?? current.gridMinutes;
      if (min % grid !== 0) {
        throw new ApiError(ErrorCode.VALIDATION, 'The minimum booking must fit the grid.', {
          field: 'minDurationMinutes',
        });
      }
      const data: Prisma.BookingRulesUpdateInput = {
        minDurationMinutes: min,
        gridMinutes: grid,
        ruleVersion: { increment: 1 },
      };
      if (dto.allowHalfHourExtension !== undefined) {
        data.allowHalfHourExtension = dto.allowHalfHourExtension;
      }
      if (dto.openingHours !== undefined) {
        data.openingHours =
          dto.openingHours === null
            ? Prisma.DbNull
            : (normalizeOpeningHours(dto.openingHours) as Prisma.InputJsonObject);
      }
      const next = await tx.bookingRules.update({ where: { pitchId }, data });
      await this.record(
        tx,
        actorId,
        'pitch.rules.update',
        pitchId,
        {
          ruleVersion: next.ruleVersion,
          allowHalfHourExtension: next.allowHalfHourExtension,
          minDurationMinutes: next.minDurationMinutes,
          gridMinutes: next.gridMinutes,
        },
        requestId,
      );
      return this.venues.pitchDtoById(tx, actorId, pitchId);
    });
  }

  // ───────────── terms ─────────────

  async createTerms(
    actorId: string,
    pitchId: string,
    dto: CreateTermsDto,
    requestId: string,
  ): Promise<BookingTermsDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.begin(tx, actorId, pitchId);
      const last = await tx.bookingTerms.findFirst({
        where: { pitchId },
        orderBy: { version: 'desc' },
      });
      const created = await tx.bookingTerms.create({
        data: { pitchId, version: (last?.version ?? 0) + 1, body: dto.body },
      });
      await this.record(
        tx,
        actorId,
        'pitch.terms.create',
        pitchId,
        { version: created.version },
        requestId,
      );
      return this.termsDto(created);
    });
  }

  async latestTerms(viewerId: string | null, pitchId: string): Promise<BookingTermsDto> {
    await this.venues.pitchOrThrow(this.prisma, viewerId, pitchId);
    const t = await this.prisma.bookingTerms.findFirst({
      where: { pitchId },
      orderBy: { version: 'desc' },
    });
    if (!t) throw notAvailable();
    return this.termsDto(t);
  }

  async listTerms(actorId: string, pitchId: string): Promise<TermsListDto> {
    const pitch = await this.venues.pitchOrThrow(this.prisma, actorId, pitchId);
    await this.venues.assertManagePitch(this.prisma, actorId, pitch);
    const rows = await this.prisma.bookingTerms.findMany({
      where: { pitchId },
      orderBy: { version: 'desc' },
    });
    return { items: rows.map((r) => this.termsDto(r)) };
  }

  private termsDto(t: { version: number; body: string; createdAt: Date }): BookingTermsDto {
    return { version: t.version, body: t.body, createdAt: t.createdAt.toISOString() };
  }

  private record(
    tx: Tx,
    actorId: string,
    action: string,
    pitchId: string,
    metadata: object,
    requestId: string,
  ): Promise<void> {
    return this.audit.record(tx, {
      actorId,
      action,
      targetType: 'PITCH',
      targetId: pitchId,
      metadata,
      requestId,
    });
  }
}
