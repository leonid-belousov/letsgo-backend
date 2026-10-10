import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PitchSetting,
  PitchSurface,
  VenueKind,
  VenueRequestStatus,
  VenueStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export const PITCH_FORMATS = ['5v5', '6v6', '7v7', '8v8', '9v9', '10v10', '11v11'] as const;
export const DEFAULT_VENUE_TIMEZONE = 'Asia/Tbilisi';
export const WHOLE_PITCH = 'Whole pitch';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// ───────────── output ─────────────

export class PitchPartDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sortOrder!: number;
}

export class PitchConfigurationDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) format!: string | null;
  @ApiProperty({ type: [String], description: 'Atomic parts this configuration occupies' })
  partIds!: string[];
}

export class BookingRulesDto {
  @ApiProperty() minDurationMinutes!: number;
  @ApiProperty() gridMinutes!: number;
  @ApiProperty() allowHalfHourExtension!: boolean;
  @ApiProperty({ description: '30 when 30-minute extensions are allowed, else 60' })
  stepMinutes!: number;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        properties: { open: { type: 'string' }, close: { type: 'string' } },
        required: ['open', 'close'],
      },
    },
    description:
      '{ mon: [{open:"09:00", close:"01:00"}], … } in the venue timezone; close <= open means next day; null = not configured',
  })
  openingHours!: Record<string, { open: string; close: string }[]> | null;
  @ApiProperty({
    description: 'Bumped on every change; bookings keep the version they were made under',
  })
  ruleVersion!: number;
}

export class BookingTermsDto {
  @ApiProperty() version!: number;
  @ApiProperty() body!: string;
  @ApiProperty() createdAt!: string;
}

export class PitchCapabilitiesDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canPublish!: boolean;
  @ApiProperty() canManageBookings!: boolean;
}

export class PitchDto {
  @ApiProperty() id!: string;
  @ApiProperty() venueId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PitchSurface, nullable: true }) surface!: PitchSurface | null;
  @ApiProperty({ enum: PitchSetting, nullable: true }) setting!: PitchSetting | null;
  @ApiProperty({ nullable: true, type: Number }) lengthM!: number | null;
  @ApiProperty({ nullable: true, type: Number }) widthM!: number | null;
  @ApiProperty({ type: [String] }) formats!: string[];
  @ApiProperty({ type: [String] }) amenities!: string[];
  @ApiProperty({ nullable: true, type: Number, description: 'Integer minor units' })
  pricePerHourMinor!: number | null;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: VenueStatus }) status!: VenueStatus;
  @ApiProperty({ description: 'Paid, published and published venue: can receive booking requests' })
  bookable!: boolean;
  @ApiProperty({ type: [PitchPartDto] }) parts!: PitchPartDto[];
  @ApiProperty({ type: [PitchConfigurationDto] }) configurations!: PitchConfigurationDto[];
  @ApiProperty({ type: BookingRulesDto, nullable: true }) bookingRules!: BookingRulesDto | null;
  @ApiProperty({ type: BookingTermsDto, nullable: true }) latestTerms!: BookingTermsDto | null;
  @ApiPropertyOptional({ description: 'Only for managers (needed for edits)' }) version?: number;
  @ApiProperty({ type: PitchCapabilitiesDto }) capabilities!: PitchCapabilitiesDto;
}

export class VenueDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) nameLocal!: string | null;
  @ApiProperty({ enum: VenueKind }) kind!: VenueKind;
  @ApiProperty({ enum: VenueStatus }) status!: VenueStatus;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true, type: String }) district!: string | null;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: Number }) latitude!: number | null;
  @ApiProperty({ nullable: true, type: Number }) longitude!: number | null;
  @ApiProperty() timezone!: string;
  @ApiProperty({ nullable: true, type: String }) about!: string | null;
  @ApiProperty({ type: [String], description: 'MediaAsset ids of submitted photos' })
  photoMediaIds!: string[];
  @ApiProperty({ description: 'Visible pitches for this viewer' }) pitchCount!: number;
  @ApiProperty({ nullable: true, type: String }) publishedAt!: string | null;
  @ApiPropertyOptional({ description: 'Only for managers (needed for edits)' }) version?: number;
}

export class VenueCapabilitiesDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canPublish!: boolean;
  @ApiProperty() canCreatePitch!: boolean;
}

export class VenueDetailDto extends VenueDto {
  @ApiProperty({ type: [PitchDto] }) pitches!: PitchDto[];
  @ApiProperty({ type: VenueCapabilitiesDto }) capabilities!: VenueCapabilitiesDto;
}

export class VenuePageDto {
  @ApiProperty({ type: [VenueDto] }) items!: VenueDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

// ───────────── catalog queries ─────────────

export class VenueListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional({ description: 'Name / address search' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  q?: string;
  @ApiPropertyOptional({ enum: VenueKind }) @IsOptional() @IsEnum(VenueKind) kind?: VenueKind;
  @ApiPropertyOptional({ enum: PitchSurface })
  @IsOptional()
  @IsEnum(PitchSurface)
  surface?: PitchSurface;
  @ApiPropertyOptional({ enum: PitchSetting })
  @IsOptional()
  @IsEnum(PitchSetting)
  setting?: PitchSetting;
  @ApiPropertyOptional({ enum: PITCH_FORMATS })
  @IsOptional()
  @IsIn(PITCH_FORMATS)
  format?: string;
}

// ───────────── staff / manager input ─────────────

class GeoFields {
  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;
}

export class CreateVenueDto extends GeoFields {
  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  nameLocal?: string;

  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  district?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ default: DEFAULT_VENUE_TIMEZONE, description: 'IANA timezone' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  about?: string;
}

export class UpdateVenueDto extends GeoFields {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  nameLocal?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  district?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string;
  @ApiPropertyOptional({ description: 'IANA timezone' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) about?: string;
  @ApiProperty({ description: 'Current `version`; stale → 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;
}

class PitchFields {
  @ApiPropertyOptional({ enum: PitchSurface })
  @IsOptional()
  @IsEnum(PitchSurface)
  surface?: PitchSurface;
  @ApiPropertyOptional({ enum: PitchSetting })
  @IsOptional()
  @IsEnum(PitchSetting)
  setting?: PitchSetting;

  @ApiPropertyOptional({ description: 'Metres' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  lengthM?: number;

  @ApiPropertyOptional({ description: 'Metres' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  widthM?: number;

  @ApiPropertyOptional({ enum: PITCH_FORMATS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PITCH_FORMATS, { each: true })
  formats?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  amenities?: string[];

  @ApiPropertyOptional({ description: 'Integer minor units (tetri)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  pricePerHourMinor?: number;

  @ApiPropertyOptional({ default: 'GEL' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}

export class CreatePitchDto extends PitchFields {
  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Atomic parts (e.g. four quarters). Default: a single part. A “Whole pitch” configuration containing all parts is created automatically.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(40, { each: true })
  partNames?: string[];
}

export class UpdatePitchDto extends PitchFields {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
  @ApiProperty({ description: 'Current `version`; stale → 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;
}

// ───────────── structure ─────────────

export class PartNameDto {
  @ApiProperty({ maxLength: 40 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;
}

export class ConfigurationInputDto {
  @ApiProperty({ maxLength: 40 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @ApiPropertyOptional({ enum: PITCH_FORMATS })
  @IsOptional()
  @IsIn(PITCH_FORMATS)
  format?: string;

  @ApiProperty({ type: [String], description: 'Parts of this pitch that the combination covers' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  partIds!: string[];
}

export class UpdateConfigurationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name?: string;
  @ApiPropertyOptional({ enum: PITCH_FORMATS, nullable: true })
  @IsOptional()
  @IsIn(PITCH_FORMATS)
  format?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  partIds?: string[];
}

export class PutBookingRulesDto {
  @ApiPropertyOptional({ minimum: 30, maximum: 480, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(480)
  minDurationMinutes?: number;

  @ApiPropertyOptional({ enum: [15, 30, 60], default: 30 })
  @IsOptional()
  @IsIn([15, 30, 60])
  gridMinutes?: number;

  @ApiPropertyOptional({ description: 'true: 60/90/120…; false: 60/120/180…' })
  @IsOptional()
  @IsBoolean()
  allowHalfHourExtension?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: '{ mon: [{open:"09:00", close:"01:00"}], … }; null clears the configuration',
  })
  @IsOptional()
  @IsObject()
  openingHours?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'If set and stale → 409 VERSION_CHANGED' })
  @IsOptional()
  @IsInt()
  expectedRuleVersion?: number;
}

export class CreateTermsDto {
  @ApiProperty({
    maxLength: 8000,
    description: 'Cancellation and minimum-squad terms; append-only',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}

export class TermsListDto {
  @ApiProperty({ type: [BookingTermsDto] }) items!: BookingTermsDto[];
}

// ───────────── community pitch & paid requests ─────────────

export class CommunityPitchDto {
  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city!: string;

  @ApiProperty({ minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({ type: [String], description: 'READY photo MediaAssets owned by you (≥ 1)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  photoMediaIds!: string[];

  @ApiProperty({ description: 'Must be true: this is a free, public pitch' })
  @IsBoolean()
  confirmedFreePublic!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  about?: string;
  @ApiPropertyOptional({ enum: PitchSurface })
  @IsOptional()
  @IsEnum(PitchSurface)
  surface?: PitchSurface;
  @ApiPropertyOptional({ enum: PitchSetting })
  @IsOptional()
  @IsEnum(PitchSetting)
  setting?: PitchSetting;
  @ApiPropertyOptional({ description: 'IANA timezone; default Asia/Tbilisi' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class CommunityPitchResultDto {
  @ApiProperty({ description: 'false when an existing pitch was returned instead' })
  created!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Existing venue id when a duplicate was detected',
  })
  duplicateOf!: string | null;
  @ApiProperty({ type: VenueDetailDto }) venue!: VenueDetailDto;
}

export class CreateVenueRequestDto {
  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city!: string;

  @ApiPropertyOptional({ description: 'Address, or a map point (latitude + longitude), or both' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiProperty({ type: [String], description: 'READY photo MediaAssets owned by you (≥ 1)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  photoMediaIds!: string[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class RespondVenueRequestDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  photoMediaIds?: string[];
}

/** What the requester sees: the answer comes from “Let’sGo”, never from a named reviewer. */
export class MyVenueRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: Number }) latitude!: number | null;
  @ApiProperty({ nullable: true, type: Number }) longitude!: number | null;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ type: [String] }) photoMediaIds!: string[];
  @ApiProperty({ enum: VenueRequestStatus }) status!: VenueRequestStatus;
  @ApiProperty({ enum: ['Let’sGo'] }) from!: 'Let’sGo';
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Message from Let’sGo (more info needed / decline reason)',
  })
  message!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Set once the pitch is published' })
  venueId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) answeredAt!: string | null;
}

export class MyVenueRequestPageDto {
  @ApiProperty({ type: [MyVenueRequestDto] }) items!: MyVenueRequestDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class AdminVenueRequestDto extends MyVenueRequestDto {
  @ApiProperty() requestedById!: string;
  @ApiProperty({ nullable: true, type: String }) requesterNickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) requesterUsername!: string | null;
  @ApiProperty({ nullable: true, type: String }) reviewedById!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Staff-side id of the created venue (may be a draft)',
  })
  resultingVenueId!: string | null;
}

export class AdminVenueRequestPageDto {
  @ApiProperty({ type: [AdminVenueRequestDto] }) items!: AdminVenueRequestDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class AdminVenueRequestQuery extends PageQuery {
  @ApiPropertyOptional({ enum: VenueRequestStatus })
  @IsOptional()
  @IsEnum(VenueRequestStatus)
  status?: VenueRequestStatus;
}

export class ApproveVenueRequestDto {
  @ApiPropertyOptional({ default: DEFAULT_VENUE_TIMEZONE })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
  @ApiPropertyOptional({ description: 'Defaults to the request name' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  pitchName?: string;
  @ApiPropertyOptional({
    default: false,
    description:
      'Explicit staff action; needs admin.catalog.manage too. Default: created as DRAFT.',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class VenueRequestMessageDto {
  @ApiProperty({ maxLength: 1000, description: 'Shown to the requester as a message from Let’sGo' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;
}
