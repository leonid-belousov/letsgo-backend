import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { CashReceivedDto, CreateAdjustmentDto, EventMoneySummaryDto, ObligationDto } from './dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments/mine')
  @ApiOkResponse({
    type: [ObligationDto],
    description: 'My obligations. Capabilities say what I may do.',
  })
  mine(@CurrentUser() user: AuthUser) {
    return this.payments.listMine(user.userId);
  }

  @Get('payments/obligations/:id')
  @ApiOkResponse({
    type: ObligationDto,
    description: 'Payer, or an authorised receiver/viewer, incl. immutable ledger',
  })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user.userId, id);
  }

  @Post('payments/obligations/:id/pay-cash')
  @HttpCode(200)
  @ApiOkResponse({
    type: ObligationDto,
    description:
      'Records the payer’s intent to pay cash and notifies receivers. Does NOT mark anything paid.',
  })
  payCash(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.payments.payCash(user.userId, id, String(req.id));
  }

  @Post('payments/obligations/:id/cash-received')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({
    type: ObligationDto,
    description:
      'Authorised receiver only (never the payer). Idempotent: retries return the same result and never double-credit.',
  })
  cashReceived(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CashReceivedDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.payments.cashReceived(user.userId, id, dto, key, String(req.id));
  }

  @Post('payments/obligations/:id/adjustments')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: ObligationDto, description: 'Append-only correction/refund record' })
  adjust(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAdjustmentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.payments.adjust(user.userId, id, dto, key, String(req.id));
  }

  @Get('games/:id/payments')
  @ApiOkResponse({
    type: EventMoneySummaryDto,
    description: 'Collected / outstanding for a game (money-view permission)',
  })
  eventSummary(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.eventSummary(user.userId, id);
  }
}
