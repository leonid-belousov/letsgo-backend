import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { AttachBookingDto, TournamentBookingListDto } from './dto/bookings.dto';
import {
  RequestWithdrawalDto,
  ResolveWithdrawalDto,
  WithdrawalDto,
  WithdrawalListDto,
} from './dto/withdrawals.dto';
import { TournamentBookingsService } from './tournament-bookings.service';
import { WithdrawalsService } from './withdrawals.service';

const idem = { name: 'Idempotency-Key', required: false, description: 'Safe retries' };

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id')
export class TournamentExtrasController {
  constructor(
    private readonly rentals: TournamentBookingsService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Get('bookings')
  @ApiOkResponse({
    type: TournamentBookingListDto,
    description: 'Rental windows attached to the tournament (tournament.schedule)',
  })
  bookings(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rentals.list(u.userId, id);
  }

  @Post('bookings')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: TournamentBookingListDto,
    description:
      'Attach a booking of a published pitch (own, a rep of an entered club, or one you may decide)',
  })
  attach(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachBookingDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.rentals.attach(u.userId, id, dto.bookingId, key, String(req.id));
  }

  @Delete('bookings/:bookingId')
  @ApiOkResponse({ type: TournamentBookingListDto })
  detach(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Req() req: Request,
  ) {
    return this.rentals.detach(u.userId, id, bookingId, String(req.id));
  }

  @Get('withdrawals')
  @ApiOkResponse({ type: WithdrawalListDto })
  list(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.withdrawals.list(u.userId, id);
  }

  @Post('entries/:entryId/withdrawal')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: WithdrawalDto,
    description:
      'A club asks to leave a running tournament (PENDING_RESOLUTION); nothing else changes',
  })
  request(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: RequestWithdrawalDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.withdrawals.request(u.userId, id, entryId, dto, key, String(req.id));
  }

  @Post('entries/:entryId/withdrawals/:withdrawalId/resolve')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: WithdrawalDto,
    description:
      'Chief organiser only. Played matches are never changed; technical results need explicit scores.',
  })
  resolve(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('withdrawalId', ParseUUIDPipe) wid: string,
    @Body() dto: ResolveWithdrawalDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.withdrawals.resolve(u.userId, id, wid, dto, key, String(req.id));
  }
}
