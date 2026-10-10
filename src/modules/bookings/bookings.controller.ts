import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { BookingsService } from './bookings.service';
import {
  AvailabilityDto,
  AvailabilityQuery,
  BlockDto,
  BookingDto,
  BookingPageDto,
  BookingReasonDto,
  CalendarDto,
  CalendarQuery,
  CreateBlockDto,
  CreateBookingDto,
  CreateExternalBookingDto,
  HoldBookingDto,
  MyBookingsQuery,
  PitchBookingsQuery,
  StaffBookingDto,
  StaffBookingPageDto,
} from './dto';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Request a pitch booking (status REQUESTED). Rules are checked on the server; terms must be accepted.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: BookingDto })
  @ApiConflictResponse({ description: 'BOOKING_CONFLICT: This time is no longer available.' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBookingDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.bookings.create(user.userId, dto, key);
  }

  @Get('mine')
  @ApiOkResponse({ type: BookingPageDto })
  mine(@CurrentUser() user: AuthUser, @Query() q: MyBookingsQuery) {
    return this.bookings.listMine(user.userId, q, q.status);
  }

  @Get(':id')
  @ApiOkResponse({ type: BookingDto })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.getMine(user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel (the booker, or venue staff). Releases the occupied time.' })
  @ApiOkResponse({ type: BookingDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BookingReasonDto,
    @Req() req: Request,
  ) {
    return this.bookings.cancel(user.userId, id, dto.reason, String(req.id));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm a request or hold (pitch.bookings.decide). Source: VENUE.' })
  @ApiOkResponse({ type: StaffBookingDto })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.bookings.confirm(user.userId, id, String(req.id));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a request or hold (pitch.bookings.decide). Releases the time.' })
  @ApiOkResponse({ type: StaffBookingDto })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BookingReasonDto,
    @Req() req: Request,
  ) {
    return this.bookings.reject(user.userId, id, dto.reason, String(req.id));
  }

  @Post(':id/hold')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hold the requested slot for a visible period (pitch.bookings.decide)' })
  @ApiOkResponse({ type: StaffBookingDto })
  hold(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HoldBookingDto,
    @Req() req: Request,
  ) {
    return this.bookings.hold(user.userId, id, dto.holdMinutes, String(req.id));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a finished confirmed booking COMPLETED (also happens lazily)' })
  @ApiOkResponse({ type: StaffBookingDto })
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.bookings.complete(user.userId, id, String(req.id));
  }
}

@ApiTags('bookings')
@Controller('pitches/:id')
export class PitchCalendarController {
  constructor(private readonly bookings: BookingsService) {}

  @Public()
  @ApiBearerAuth()
  @Get('availability')
  @ApiOperation({
    summary:
      'Free intervals of a configuration on a local date, considering every part it occupies',
  })
  @ApiOkResponse({ type: AvailabilityDto })
  availability(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: AvailabilityQuery,
  ) {
    return this.bookings.availability(viewer?.userId ?? null, id, q.date, q.configurationId);
  }

  @ApiBearerAuth()
  @Get('calendar')
  @ApiOperation({
    summary:
      'Manager calendar with external flag and staff-only name/phone/note (pitch.calendar.manage)',
  })
  @ApiOkResponse({ type: CalendarDto })
  calendar(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CalendarQuery,
  ) {
    return this.bookings.calendar(user.userId, id, q.from, q.to);
  }

  @ApiBearerAuth()
  @Get('bookings')
  @ApiOperation({ summary: 'Booking inbox of the pitch (venue staff)' })
  @ApiOkResponse({ type: StaffBookingPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PitchBookingsQuery,
  ) {
    return this.bookings.listForPitch(user.userId, id, q, q.status);
  }

  @ApiBearerAuth()
  @Get('bookings/:bookingId')
  @ApiOkResponse({ type: StaffBookingDto })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ) {
    return this.bookings.getForStaff(user.userId, id, bookingId);
  }

  @ApiBearerAuth()
  @Post('bookings/external')
  @ApiOperation({
    summary:
      'Add an external booking (pitch.calendar.manage): CONFIRMED at once, source EXTERNAL, same rule validator',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: StaffBookingDto })
  createExternal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateExternalBookingDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.bookings.createExternal(user.userId, id, dto, key, String(req.id));
  }

  @ApiBearerAuth()
  @Post('blocks')
  @ApiOperation({
    summary: 'Block a slot (30 minutes minimum); occupies the parts (pitch.calendar.manage)',
  })
  @ApiCreatedResponse({ type: BlockDto })
  createBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBlockDto,
    @Req() req: Request,
  ) {
    return this.bookings.createBlock(user.userId, id, dto, String(req.id));
  }

  @ApiBearerAuth()
  @Delete('blocks/:blockId')
  @HttpCode(200)
  @ApiOkResponse({ type: BlockDto })
  cancelBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Req() req: Request,
  ) {
    return this.bookings.cancelBlock(user.userId, id, blockId, String(req.id));
  }
}
