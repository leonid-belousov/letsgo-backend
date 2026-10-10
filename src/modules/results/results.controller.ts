import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  AddMatchEventDto,
  CancelMatchDto,
  CaptainDto,
  ConfirmMatchDto,
  CorrectMatchDto,
  CreateMatchDto,
  DecideMvpDto,
  HistoryQuery,
  MatchDto,
  MatchListDto,
  MatchRevisionsDto,
  MvpSummaryDto,
  SetCaptainDto,
  SetScoreDto,
  SubmitMatchDto,
  UserHistoryDto,
  UserStatsDto,
  VoteMvpDto,
} from './dto';
import { ResultsService } from './results.service';
import { StatsService } from './stats.service';

const idem = {
  name: 'Idempotency-Key',
  required: false,
  description: 'Safe retries: same key + payload ⇒ same result',
};

@ApiTags('results')
@ApiBearerAuth()
@Controller()
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Public()
  @Get('games/:id/matches')
  @ApiOkResponse({
    type: MatchListDto,
    description: 'Unconfirmed protocols are visible only to people working on them',
  })
  list(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.list(viewer?.userId ?? null, id);
  }

  @Post('games/:id/matches')
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: MatchDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMatchDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.create(user.userId, id, dto, key, String(req.id));
  }

  @Put('games/:id/teams/:teamId/captain')
  @ApiOkResponse({
    type: CaptainDto,
    description: 'Appoint (userId) or clear (null) the team captain',
  })
  setCaptain(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: SetCaptainDto,
    @Req() req: Request,
  ) {
    return this.results.setCaptain(user.userId, id, teamId, dto.userId ?? null, String(req.id));
  }

  @Public()
  @Get('matches/:id')
  @ApiOkResponse({ type: MatchDto })
  get(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.get(viewer?.userId ?? null, id);
  }

  @Get('matches/:id/revisions')
  @ApiOkResponse({
    type: MatchRevisionsDto,
    description: 'Immutable history of corrections (results staff only)',
  })
  revisions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.revisions(user.userId, id);
  }

  @Post('matches/:id/events')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: MatchDto,
    description: 'Goal / own goal / cards. Captains: own team only, until confirmation.',
  })
  addEvent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMatchEventDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.results.addEvent(user.userId, id, dto, key);
  }

  @Delete('matches/:id/events/:eventId')
  @ApiOkResponse({ type: MatchDto })
  removeEvent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query('version') version?: string,
  ) {
    const v = version === undefined || version === '' ? undefined : Number(version);
    return this.results.removeEvent(
      user.userId,
      id,
      eventId,
      v !== undefined && Number.isInteger(v) ? v : undefined,
    );
  }

  @Put('matches/:id/score')
  @ApiHeader(idem)
  @ApiOkResponse({
    type: MatchDto,
    description: 'Plain score; 409 SCORE_DERIVED when goals were recorded as events',
  })
  setScore(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetScoreDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.results.setScore(user.userId, id, dto, key);
  }

  @Post('matches/:id/submit')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: MatchDto, description: 'DRAFT → AWAITING_CONFIRMATION' })
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitMatchDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.results.submit(user.userId, id, dto.version, key);
  }

  @Post('matches/:id/confirm')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: MatchDto,
    description: 'Final confirmation (event.results.confirm holders only). Opens MVP voting.',
  })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmMatchDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.confirm(user.userId, id, dto.version, key, String(req.id));
  }

  @Post('matches/:id/cancel')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: MatchDto,
    description: 'Only before confirmation; a cancelled match never opens voting',
  })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelMatchDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.cancel(user.userId, id, dto, key, String(req.id));
  }

  @Post('matches/:id/correct')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: MatchDto,
    description: 'Correction after confirmation: mandatory reason, immutable revision, audit',
  })
  correct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectMatchDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.correct(user.userId, id, dto, key, String(req.id));
  }

  // ── MVP ──

  @Public()
  @Get('matches/:id/mvp')
  @ApiOkResponse({ type: MvpSummaryDto })
  mvp(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.mvpSummary(viewer?.userId ?? null, id);
  }

  @Put('matches/:id/mvp/vote')
  @ApiOkResponse({
    type: MvpSummaryDto,
    description: 'One vote per confirmed player; no self-vote; changeable while the window is open',
  })
  vote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoteMvpDto,
  ) {
    return this.results.vote(user.userId, id, dto.candidateId);
  }

  @Post('matches/:id/mvp/decision')
  @HttpCode(200)
  @ApiOkResponse({
    type: MvpSummaryDto,
    description: 'Explicit tie-break by the results manager after the window closed',
  })
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideMvpDto,
    @Req() req: Request,
  ) {
    return this.results.decideMvp(user.userId, id, dto.mvpUserId, String(req.id));
  }
}

@ApiTags('results')
@Controller('users')
export class UserStatsController {
  constructor(private readonly stats: StatsService) {}

  @Public()
  @ApiBearerAuth()
  @Get(':id/stats')
  @ApiOkResponse({
    type: UserStatsDto,
    description: 'Derived from confirmed matches only. Hidden ⇒ { hidden: true } and no numbers.',
  })
  getStats(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.stats.stats(viewer?.userId ?? null, id);
  }

  @Public()
  @ApiBearerAuth()
  @Get(':id/history')
  @ApiOkResponse({ type: UserHistoryDto })
  getHistory(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: HistoryQuery,
  ) {
    return this.stats.history(viewer?.userId ?? null, id, q);
  }
}
