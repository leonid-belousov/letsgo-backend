import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookingSource, BookingStatus, ConfirmationSource } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
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

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// ───────────── input ─────────────

export class CreateBookingDto {
  @ApiProperty() @IsUUID() pitchId!: string;
  @ApiProperty({ description: 'Bookable combination of parts (e.g. “Whole pitch”, “Half A”)' })
  @IsUUID()
  configurationId!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'UTC instant of the start' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty({ description: 'Whole minutes; validated against the pitch’s booking rules' })
  @IsInt()
  @Min(30)
  @Max(720)
  durationMinutes!: number;

  @ApiPropertyOptional({
    description:
      'Terms version being accepted; must equal the latest version (required once the pitch has terms)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  termsVersion?: number;
}

export class CreateExternalBookingDto {
  @ApiProperty() @IsUUID() configurationId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty() @IsInt() @Min(30) @Max(720) durationMinutes!: number;

  @ApiProperty({ maxLength: 80, description: 'Name or team (required)' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  externalName!: string;

  @ApiPropertyOptional({
    maxLength: 30,
    description: 'Staff only. Creates no account, sends nothing.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  externalPhone?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Staff only' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  staffNote?: string;
}

export class CreateBlockDto {
  @ApiPropertyOptional({ description: 'Defaults to the “Whole pitch” configuration' })
  @IsOptional()
  @IsUUID()
  configurationId?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty({ description: 'Multiple of the grid; 30 minutes is allowed' })
  @IsInt()
  @Min(15)
  @Max(1440)
  durationMinutes!: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class HoldBookingDto {
  @ApiProperty({ minimum: 5, maximum: 1440 })
  @IsInt()
  @Min(5)
  @Max(1440)
  holdMinutes!: number;
}

export class BookingReasonDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class AvailabilityQuery {
  @ApiProperty({ example: '2026-10-01', description: 'Local calendar date at the venue' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiPropertyOptional({ description: 'Defaults to the “Whole pitch” configuration' })
  @IsOptional()
  @IsUUID()
  configurationId?: string;
}

export class CalendarQuery {
  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'At most 62 days after `from`' })
  @Type(() => Date)
  @IsDate()
  to!: Date;
}

export class PitchBookingsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

export class MyBookingsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

// ───────────── output ─────────────

export class BookingDto {
  @ApiProperty() id!: string;
  @ApiProperty() pitchId!: string;
  @ApiProperty() venueId!: string;
  @ApiProperty() configurationId!: string;
  @ApiProperty() configurationName!: string;
  @ApiProperty({ enum: BookingSource }) source!: BookingSource;
  @ApiProperty({ enum: BookingStatus }) status!: BookingStatus;
  @ApiProperty({
    description:
      '“Pitch booked” for clients means status CONFIRMED only — never a request or a hold',
  })
  pitchBooked!: boolean;
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Visible expiry of a temporary hold' })
  holdExpiresAt!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Integer minor units' })
  priceMinor!: number | null;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Booking-rule version this booking was validated under' })
  rulesVersion!: number;
  @ApiProperty({ nullable: true, type: Number }) termsVersion!: number | null;
  @ApiProperty({ nullable: true, type: String }) termsAcceptedAt!: string | null;
  @ApiProperty({ enum: ConfirmationSource, nullable: true })
  confirmationSource!: ConfirmationSource | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) bookedById!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
}

export class BookerSummaryDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
}

/** Venue-staff view: adds the booker and every external / internal field. */
export class StaffBookingDto extends BookingDto {
  @ApiProperty({
    description: 'A booking entered by staff (phone, walk-in); not a Let’sGo user booking',
  })
  isExternal!: boolean;
  @ApiProperty({ type: BookerSummaryDto, nullable: true }) booker!: BookerSummaryDto | null;
  @ApiProperty({ nullable: true, type: String }) externalName!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalPhone!: string | null;
  @ApiProperty({ nullable: true, type: String }) staffNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) confirmedById!: string | null;
}

export class StaffBookingPageDto {
  @ApiProperty({ type: [StaffBookingDto] }) items!: StaffBookingDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class BookingPageDto {
  @ApiProperty({ type: [BookingDto] }) items!: BookingDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class TimeIntervalDto {
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
}

export class AvailabilityDto {
  @ApiProperty() pitchId!: string;
  @ApiProperty() configurationId!: string;
  @ApiProperty() date!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() minDurationMinutes!: number;
  @ApiProperty() gridMinutes!: number;
  @ApiProperty() stepMinutes!: number;
  @ApiProperty() rulesVersion!: number;
  @ApiProperty({
    type: [TimeIntervalDto],
    description:
      'Free stretches of the configuration (all its parts free), inside opening hours, at least the minimum long',
  })
  intervals!: TimeIntervalDto[];
}

export class CalendarEntryDto {
  @ApiProperty({ enum: ['BOOKING', 'BLOCK'] }) kind!: 'BOOKING' | 'BLOCK';
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) configurationId!: string | null;
  @ApiProperty({ nullable: true, type: String }) configurationName!: string | null;
  @ApiProperty({ type: [String] }) partIds!: string[];
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty({ enum: BookingStatus, nullable: true }) status!: BookingStatus | null;
  @ApiProperty() isExternal!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'External name or booker nickname' })
  title!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class CalendarDto {
  @ApiProperty() pitchId!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: [CalendarEntryDto] }) entries!: CalendarEntryDto[];
}

export class BlockDto {
  @ApiProperty() id!: string;
  @ApiProperty() pitchId!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ type: [String] }) partIds!: string[];
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
}

/** What the games module needs to link a game to a booking. */
export interface BookingEventLink {
  id: string;
  pitchId: string;
  venueId: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  bookedById: string | null;
  confirmationSource: ConfirmationSource | null;
}
