import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  AppointAssistantDto,
  AssistantsDto,
  CancelTournamentDto,
  CreateTournamentDto,
  FinishTournamentDto,
  PostponeTournamentDto,
  RevokedDto,
  TournamentDto,
  TournamentListQuery,
  TournamentPageDto,
  UpdateTournamentDto,
} from './dto/tournament.dto';
import { TournamentsService } from './tournaments.service';

const idem = {
  name: 'Idempotency-Key',
  required: false,
  description: 'Safe retries: same key + payload gives the same result',
};

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Public()
  @Get()
  @ApiOkResponse({
    type: TournamentPageDto,
    description:
      'Cards, keyset pagination. UPCOMING (default) hides FINISHED/CANCELLED; ANY includes them.',
  })
  list(@OptionalUser() viewer: AuthUser | null, @Query() q: TournamentListQuery) {
    return this.tournaments.list(viewer?.userId ?? null, q);
  }

  @Post()
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: TournamentDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.create(user.userId, dto, key, String(req.id));
  }

  @Public()
  @Get(':id')
  @ApiOkResponse({
    type: TournamentDto,
    description: 'Page with counters, viewer state and server-computed capabilities',
  })
  get(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.tournaments.get(viewer?.userId ?? null, id);
  }

  @Patch(':id')
  @ApiHeader(idem)
  @ApiOkResponse({
    type: TournamentDto,
    description: '409 VERSION_CHANGED when `version` is stale',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.update(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: TournamentDto,
    description: 'DRAFT -> REGISTRATION_OPEN (needs no full entries, consents or bookings)',
  })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.publish(user.userId, id, key, String(req.id));
  }

  @Post(':id/close-registration')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: TournamentDto })
  close(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.closeRegistration(user.userId, id, key, String(req.id));
  }

  @Post(':id/open-registration')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: TournamentDto })
  reopen(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.openRegistration(user.userId, id, key, String(req.id));
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: TournamentDto,
    description:
      '409 CONFLICT with details.problems (concrete list) when not ready; nothing changes',
  })
  start(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.start(user.userId, id, key, String(req.id));
  }

  @Post(':id/finish')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: TournamentDto })
  finish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinishTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.finish(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/postpone')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: TournamentDto })
  postpone(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostponeTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.postpone(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: TournamentDto })
  resume(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.resume(user.userId, id, key, String(req.id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: TournamentDto,
    description: 'Keeps history; unpaid fees cancelled, paid ones become REFUND_DUE',
  })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.tournaments.cancel(user.userId, id, dto, key, String(req.id));
  }

  // assistants

  @Get(':id/assistants')
  @ApiOkResponse({ type: AssistantsDto })
  assistants(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tournaments.assistants(user.userId, id);
  }

  @Post(':id/assistants')
  @HttpCode(200)
  @ApiOkResponse({
    type: AssistantsDto,
    description: 'Max two distinct assistants; module permissions only; after publication',
  })
  appoint(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AppointAssistantDto,
    @Req() req: Request,
  ) {
    return this.tournaments.appoint(user.userId, id, dto, String(req.id));
  }

  @Delete(':id/assistants/:userId')
  @ApiOkResponse({ type: RevokedDto })
  dismiss(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ) {
    return this.tournaments.dismiss(user.userId, id, userId, String(req.id));
  }
}
