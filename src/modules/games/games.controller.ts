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
  AttachBookingDto,
  CancelGameDto,
  CreateGameDto,
  CreateInvitationsDto,
  ExtendInvitationDto,
  GameDto,
  GameListQuery,
  GamePageDto,
  InvitationDto,
  JoinDto,
  MoveDto,
  MyInvitationDto,
  MyInvitationsQuery,
  ParticipationDto,
  PlayersDto,
  UpdateGameDto,
} from './dto';
import { GamesService } from './games.service';
import { InviteResultDto } from './dto';
import { InvitationsService, type InviteResult } from './invitations.service';
import { ParticipationService } from './participation.service';

const idem = {
  name: 'Idempotency-Key',
  required: false,
  description: 'Safe retries: same key + payload ⇒ same result',
};

@ApiTags('games')
@ApiBearerAuth()
@Controller('games')
export class GamesController {
  constructor(
    private readonly games: GamesService,
    private readonly participation: ParticipationService,
    private readonly invitations: InvitationsService,
  ) {}

  @Public()
  @Get()
  @ApiOkResponse({
    type: GamePageDto,
    description:
      'Home feed / search: OR inside a filter group, AND between groups; keyset pagination.',
  })
  list(@OptionalUser() viewer: AuthUser | null, @Query() q: GameListQuery) {
    return this.games.list(viewer?.userId ?? null, q);
  }

  @Post()
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: GameDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateGameDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.games.create(user.userId, dto, key, String(req.id));
  }

  @Get('invitations/mine')
  @ApiOkResponse({
    type: [MyInvitationDto],
    description:
      'Pinned above the feed; never hidden by filters (matchesFilters says whether it also matches them)',
  })
  myInvitations(@CurrentUser() user: AuthUser, @Query() q: MyInvitationsQuery) {
    return this.invitations.mine(user.userId, q);
  }

  @Public()
  @Get(':id')
  @ApiOkResponse({
    type: GameDto,
    description: 'Viewer-aware detail with server-computed capabilities',
  })
  get(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.games.get(viewer?.userId ?? null, id);
  }

  @Public()
  @Get(':id/players')
  @ApiOkResponse({ type: PlayersDto })
  players(@OptionalUser() viewer: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.games.players(viewer?.userId ?? null, id);
  }

  @Patch(':id')
  @ApiHeader(idem)
  @ApiOkResponse({ type: GameDto, description: '409 VERSION_CHANGED when `version` is stale' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGameDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.games.update(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: GameDto })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.games.publish(user.userId, id, key);
  }

  @Post(':id/booking')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: GameDto,
    description:
      'Attach a (replacement) booking. Pitch status is derived from it; clears venue-needs-attention.',
  })
  attachBooking(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachBookingDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.games.attachBooking(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: GameDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelGameDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.games.cancel(user.userId, id, dto, key, String(req.id));
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiOkResponse({ type: GameDto })
  start(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.games.start(user.userId, id, key);
  }

  @Post(':id/finish')
  @HttpCode(200)
  @ApiOkResponse({ type: GameDto })
  finish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.games.finish(user.userId, id, key);
  }

  // ── participation ──

  @Post(':id/join')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ParticipationDto,
    description:
      'CONFIRMED, PENDING_APPROVAL or WAITLISTED. Final seat under concurrency: exactly one winner; the loser gets 409 CAPACITY_CHANGED (or the waitlist).',
  })
  join(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: JoinDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.join(user.userId, id, dto, key);
  }

  @Delete(':id/participation')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ParticipationDto,
    description: 'Leave the game / the waitlist / withdraw a request',
  })
  leave(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.leave(user.userId, id, key);
  }

  @Post('participations/:pid/approve')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: ParticipationDto })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('pid', ParseUUIDPipe) pid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.approve(user.userId, pid, key);
  }

  @Post('participations/:pid/decline')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: ParticipationDto })
  decline(
    @CurrentUser() user: AuthUser,
    @Param('pid', ParseUUIDPipe) pid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.decline(user.userId, pid, key);
  }

  @Post('participations/:pid/remove')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: ParticipationDto })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('pid', ParseUUIDPipe) pid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.remove(user.userId, pid, key);
  }

  @Post('participations/:pid/move')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ParticipationDto,
    description: 'Atomic team move; one person can never hold two places',
  })
  move(
    @CurrentUser() user: AuthUser,
    @Param('pid', ParseUUIDPipe) pid: string,
    @Body() dto: MoveDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.move(user.userId, pid, dto, key);
  }

  @Post('waitlist-offers/:oid/accept')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ParticipationDto,
    description:
      'Explicit acceptance; creates the obligation only now. 410 EXPIRED after the deadline.',
  })
  acceptOffer(
    @CurrentUser() user: AuthUser,
    @Param('oid', ParseUUIDPipe) oid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.acceptOffer(user.userId, oid, key);
  }

  @Post('waitlist-offers/:oid/decline')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: ParticipationDto })
  declineOffer(
    @CurrentUser() user: AuthUser,
    @Param('oid', ParseUUIDPipe) oid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.participation.declineOffer(user.userId, oid, key);
  }

  // ── invitations (organiser side) ──

  @Post(':id/invitations')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: InviteResultDto,
    description:
      'Several guests/players at once. Priority ⇒ holds places until respondBy (never above free capacity).',
  })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInvitationsDto,
    @IdempotencyKey() key: string | undefined,
  ): Promise<InviteResult> {
    return this.invitations.create(user.userId, id, dto, key);
  }

  @Post(':id/invitations/remaining-club-players')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: InviteResultDto })
  inviteRemaining(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendInvitationDto,
    @IdempotencyKey() key: string | undefined,
  ): Promise<InviteResult> {
    return this.invitations.inviteRemainingClubPlayers(user.userId, id, dto.respondBy, key);
  }

  @Get(':id/invitations')
  @ApiOkResponse({ type: [InvitationDto] })
  listInvitations(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.listForEvent(user.userId, id);
  }

  @Post('invitations/:iid/revoke')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: InvitationDto })
  revokeInvitation(
    @CurrentUser() user: AuthUser,
    @Param('iid', ParseUUIDPipe) iid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.invitations.revoke(user.userId, iid, key);
  }

  @Post('invitations/:iid/deadline')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: InvitationDto, description: 'Notifies the invitee; never adds capacity' })
  extend(
    @CurrentUser() user: AuthUser,
    @Param('iid', ParseUUIDPipe) iid: string,
    @Body() dto: ExtendInvitationDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.invitations.extend(user.userId, iid, dto.respondBy, key);
  }

  // ── invitations (invitee side) ──

  @Post('invitations/:iid/confirm')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ParticipationDto,
    description:
      'Re-validates everything: 410 EXPIRED (deadline/cancelled), 409 CAPACITY_CHANGED, age rules still apply. Idempotent.',
  })
  confirmInvitation(
    @CurrentUser() user: AuthUser,
    @Param('iid', ParseUUIDPipe) iid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.invitations.respond(user.userId, iid, true, key);
  }

  @Post('invitations/:iid/decline')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: InvitationDto, description: 'Releases any hold immediately' })
  declineInvitation(
    @CurrentUser() user: AuthUser,
    @Param('iid', ParseUUIDPipe) iid: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.invitations.respond(user.userId, iid, false, key);
  }
}
