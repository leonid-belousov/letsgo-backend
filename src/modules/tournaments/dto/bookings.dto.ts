import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import { IsUUID } from 'class-validator';

export class AttachBookingDto {
  @ApiProperty({ description: 'A rental (booking) that provides a window for the tournament' })
  @IsUUID()
  bookingId!: string;
}

export const BOOKING_PROBLEM_CODES = [
  'WINDOW_UNCONFIRMED',
  'OUTSIDE_BOOKED_WINDOW',
  'WINDOW_LOST',
  'RESOURCE_UNAVAILABLE',
  'UNBOOKED',
] as const;

export class BookingProblemDto {
  @ApiProperty({
    enum: BOOKING_PROBLEM_CODES,
    description:
      'WINDOW_UNCONFIRMED (held/requested), OUTSIDE_BOOKED_WINDOW, WINDOW_LOST (cancelled/rejected/expired), ' +
      'RESOURCE_UNAVAILABLE (foreign booking/block on an unbooked pitch), UNBOOKED (non-blocking warning)',
  })
  code!: string;
  @ApiProperty() message!: string;
  @ApiProperty() fixtureId!: string;
  @ApiProperty() pitchId!: string;
  @ApiPropertyOptional() bookingId?: string;
}

export class TournamentBookingDto {
  @ApiProperty() bookingId!: string;
  @ApiProperty() pitchId!: string;
  @ApiProperty() pitchName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
  @ApiProperty({ enum: BookingStatus }) status!: BookingStatus;
  @ApiProperty({
    enum: ['CONFIRMED', 'PENDING', 'LOST'],
    description: 'Whether the window can be relied on',
  })
  effective!: string;
  @ApiProperty() attachedById!: string;
  @ApiProperty({ type: String, format: 'date-time' }) attachedAt!: string;
  @ApiProperty({ description: 'Scheduled fixtures that lie inside this window' })
  fixtureCount!: number;
}

export class TournamentBookingListDto {
  @ApiProperty({ type: [TournamentBookingDto] }) items!: TournamentBookingDto[];
}
