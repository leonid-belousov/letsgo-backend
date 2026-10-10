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
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  AgeExceptionDecisionDto,
  DecideEntryDto,
  EnterTournamentDto,
  EntryDto,
  EntryListQuery,
  EntryPageDto,
  InviteClubDto,
  InvitePlayersDto,
  InvitePlayersResultDto,
  MyPlayerDto,
  RespondInvitationDto,
  SquadDto,
} from './dto/entries.dto';
import { EntriesService } from './entries.service';

const idem = { name: 'Idempotency-Key', required: false, description: 'Safe retries' };

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Post('entries')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: EntryDto,
    description: '"Enter with my club" - needs club.tournaments.enter on that club; idempotent',
  })
  enter(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnterTournamentDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.entries.enter(u.userId, id, dto, key, String(req.id));
  }

  @Get('entries')
  @ApiOkResponse({
    type: EntryPageDto,
    description: 'Organiser / tournament.applications assistant',
  })
  list(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: EntryListQuery,
  ) {
    return this.entries.list(u.userId, id, q);
  }

  @Get('entries/mine')
  @ApiOkResponse({ type: [EntryDto], description: 'Entries of the clubs I can act for' })
  mine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.entries.mine(u.userId, id);
  }

  @Get('entries/:entryId')
  @ApiOkResponse({ type: EntryDto })
  get(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.entries.get(u.userId, id, entryId);
  }

  @Post('entries/:entryId/decision')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: EntryDto,
    description:
      'Accept respects maxClubs under a row lock: WAITLISTED when waitlistOpen, else 409 CAPACITY_CHANGED',
  })
  decide(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: DecideEntryDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.entries.decide(u.userId, id, entryId, dto, key, String(req.id));
  }

  @Post('entries/:entryId/respond')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: EntryDto, description: 'The invited club accepts or declines' })
  respond(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: RespondInvitationDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.entries.respond(u.userId, id, entryId, dto, key);
  }

  @Post('entries/:entryId/withdraw')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: EntryDto })
  withdraw(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.entries.withdraw(u.userId, id, entryId, key, String(req.id));
  }

  @Post('club-invitations')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: EntryDto,
    description: 'Targeted invitation (INVITED, holds a spot); coexists with open applications',
  })
  inviteClub(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteClubDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.entries.inviteClub(u.userId, id, dto, key, String(req.id));
  }

  // squad

  @Get('entries/:entryId/squad')
  @ApiOkResponse({ type: SquadDto })
  squad(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.entries.squad(u.userId, id, entryId);
  }

  @Post('entries/:entryId/players')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: InvitePlayersResultDto,
    description: 'Invite several players/guests at once; age and privacy rules apply to everybody',
  })
  invitePlayers(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: InvitePlayersDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.entries.invitePlayers(u.userId, id, entryId, dto, key, String(req.id));
  }

  @Delete('entries/:entryId/players/:userId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: SquadDto })
  removePlayer(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.entries.removePlayer(u.userId, id, entryId, userId, key);
  }

  @Post('entries/:entryId/players/:userId/age-exception')
  @HttpCode(200)
  @ApiOkResponse({
    type: SquadDto,
    description: 'Chief organiser only; recorded with reason, author and time',
  })
  ageException(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AgeExceptionDecisionDto,
    @Req() req: Request,
  ) {
    return this.entries.decideAgeException(u.userId, id, entryId, userId, dto, String(req.id));
  }

  // the player's own side

  @Get('players/me')
  @ApiOkResponse({ type: MyPlayerDto })
  me(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.entries.me(u.userId, id);
  }

  @Post('players/me/confirm')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: MyPlayerDto })
  confirm(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.entries.confirm(u.userId, id, key);
  }

  @Post('players/me/decline')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: MyPlayerDto })
  decline(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.entries.decline(u.userId, id, key);
  }
}
