import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  FeeAmendmentDto,
  FeeAmendmentPageDto,
  ListFeeAmendmentsQuery,
  ProposeFeeAmendmentDto,
  ProposeFeeAmendmentResultDto,
  RespondFeeAmendmentDto,
} from './fee-amendments.dto';
import { FeeAmendmentsService } from './fee-amendments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class FeeAmendmentsController {
  constructor(private readonly amendments: FeeAmendmentsService) {}

  @Post('games/:id/fee-amendments')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: ProposeFeeAmendmentResultDto,
    description:
      'Changes the game price for future joiners and asks every confirmed payer whose fee differs to accept the new amount. Obligations and receipts are not touched until a player accepts.',
  })
  propose(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProposeFeeAmendmentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.amendments.propose(user.userId, id, dto, key, String(req.id));
  }

  @Get('games/:id/fee-amendments')
  @ApiOkResponse({
    type: FeeAmendmentPageDto,
    description: 'Fee change proposals of a game (money view, cash confirm or fee change)',
  })
  listForEvent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListFeeAmendmentsQuery,
  ) {
    return this.amendments.listForEvent(user.userId, id, query);
  }

  @Get('payments/amendments/mine')
  @ApiOkResponse({ type: [FeeAmendmentDto], description: 'My fee change proposals, pending first' })
  mine(@CurrentUser() user: AuthUser) {
    return this.amendments.listMine(user.userId);
  }

  @Post('payments/amendments/:id/accept')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: FeeAmendmentDto,
    description:
      'Only the affected participant. Applies the new amount to their obligation (receipts untouched; any excess becomes Refund due). Repeating an accept returns the same result.',
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondFeeAmendmentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.amendments.accept(user.userId, id, dto, key, String(req.id));
  }

  @Post('payments/amendments/:id/reject')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: FeeAmendmentDto,
    description: 'Only the affected participant. The obligation stays as it was.',
  })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondFeeAmendmentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.amendments.reject(user.userId, id, dto, key, String(req.id));
  }

  @Post('payments/amendments/:id/cancel')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: FeeAmendmentDto,
    description: 'Withdraws a pending proposal (people who may change the game’s fees).',
  })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.amendments.cancel(user.userId, id, key, String(req.id));
  }
}
