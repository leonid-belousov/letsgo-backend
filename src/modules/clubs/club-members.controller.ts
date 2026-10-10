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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { ClubMembersService } from './club-members.service';
import { ClubOwnershipService } from './club-ownership.service';
import {
  CreateTransferDto,
  InviteMembersDto,
  InviteResultDto,
  MemberDto,
  MemberPageDto,
  MembershipResultDto,
  MyInvitationPageDto,
  OwnershipTransferDto,
  OwnershipTransferListDto,
  SetMemberTitleDto,
} from './dto';

@ApiTags('clubs')
@Controller('clubs/:id')
export class ClubMembersController {
  constructor(
    private readonly members: ClubMembersService,
    private readonly ownership: ClubOwnershipService,
  ) {}

  // ── self-service ──

  @ApiBearerAuth()
  @Post('join')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Join (OPEN → MEMBER), request (APPROVE_REQUESTS → REQUESTED) or ACCESS_DENIED (INVITE_ONLY)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: MembershipResultDto })
  join(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.members.join(user.userId, id, key);
  }

  @ApiBearerAuth()
  @Post('join/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw my pending join request' })
  @ApiOkResponse({ type: MembershipResultDto })
  cancelRequest(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.cancelRequest(user.userId, id);
  }

  @ApiBearerAuth()
  @Post('leave')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Leave the club. The owner cannot leave before transferring ownership.',
  })
  @ApiOkResponse({ type: MembershipResultDto })
  leave(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.leave(user.userId, id);
  }

  // ── invitations ──

  @ApiBearerAuth()
  @Post('invitations')
  @ApiOperation({
    summary:
      'Invite several people at once (club.members.invite); honours invitation policy and blocks',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: InviteResultDto })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteMembersDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.members.invite(user.userId, id, dto.userIds, key);
  }

  @ApiBearerAuth()
  @Delete('invitations/:userId')
  @HttpCode(204)
  @ApiNoContentResponse()
  async cancelInvitation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.members.cancelInvitation(user.userId, id, userId);
  }

  @ApiBearerAuth()
  @Post('invitation/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: MembershipResultDto })
  acceptInvitation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.respondToInvitation(user.userId, id, true);
  }

  @ApiBearerAuth()
  @Post('invitation/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: MembershipResultDto })
  declineInvitation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.respondToInvitation(user.userId, id, false);
  }

  // ── join requests ──

  @ApiBearerAuth()
  @Post('requests/:userId/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a join request (club.members.approve)' })
  @ApiOkResponse({ type: MembershipResultDto })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ) {
    return this.members.decideRequest(user.userId, id, userId, true, String(req.id));
  }

  @ApiBearerAuth()
  @Post('requests/:userId/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline a join request (club.members.approve)' })
  @ApiOkResponse({ type: MembershipResultDto })
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ) {
    return this.members.decideRequest(user.userId, id, userId, false, String(req.id));
  }

  // ── members ──

  @ApiBearerAuth()
  @Delete('members/:userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a member (club.members.remove). The owner cannot be removed.' })
  @ApiOkResponse({ type: MembershipResultDto })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ) {
    return this.members.remove(user.userId, id, userId, String(req.id));
  }

  @ApiBearerAuth()
  @Patch('members/:userId/title')
  @ApiOperation({
    summary:
      'Set the free-text role title (display only; requires club.members.approve; grants nothing)',
  })
  @ApiOkResponse({ type: MemberDto })
  setTitle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetMemberTitleDto,
  ) {
    return this.members.setTitle(user.userId, id, userId, dto);
  }

  @Public()
  @ApiBearerAuth()
  @Get('members')
  @ApiOperation({ summary: 'Members (members of the club, or everybody for a PUBLIC club)' })
  @ApiOkResponse({ type: MemberPageDto })
  listMembers(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: PageQuery,
  ) {
    return this.members.listMembers(viewer?.userId ?? null, id, page);
  }

  @ApiBearerAuth()
  @Get('requests')
  @ApiOperation({ summary: 'Pending join requests (club.members.approve)' })
  @ApiOkResponse({ type: MemberPageDto })
  listRequests(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: PageQuery,
  ) {
    return this.members.listRequests(user.userId, id, page);
  }

  @ApiBearerAuth()
  @Get('invited')
  @ApiOperation({ summary: 'Outstanding invitations (club.members.invite or approve)' })
  @ApiOkResponse({ type: MemberPageDto })
  listInvited(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: PageQuery,
  ) {
    return this.members.listInvited(user.userId, id, page);
  }

  // ── ownership transfer ──

  @ApiBearerAuth()
  @Post('ownership-transfers')
  @ApiOperation({
    summary: 'Offer ownership to a specific active user (owner only, one pending per club)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: OwnershipTransferDto })
  offerOwnership(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTransferDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.ownership.create(user.userId, id, dto.toUserId, key, String(req.id));
  }

  @ApiBearerAuth()
  @Get('ownership-transfers')
  @ApiOperation({ summary: 'Pending offer for this club (visible to the owner and the recipient)' })
  @ApiOkResponse({ type: OwnershipTransferListDto })
  listTransfers(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ownership.listForClub(user.userId, id);
  }

  @ApiBearerAuth()
  @Post('ownership-transfers/:transferId/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: OwnershipTransferDto })
  acceptTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('transferId', ParseUUIDPipe) transferId: string,
    @Req() req: Request,
  ) {
    return this.ownership.accept(user.userId, id, transferId, String(req.id));
  }

  @ApiBearerAuth()
  @Post('ownership-transfers/:transferId/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: OwnershipTransferDto })
  declineTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('transferId', ParseUUIDPipe) transferId: string,
    @Req() req: Request,
  ) {
    return this.ownership.decline(user.userId, id, transferId, String(req.id));
  }

  @ApiBearerAuth()
  @Post('ownership-transfers/:transferId/cancel')
  @HttpCode(200)
  @ApiOkResponse({ type: OwnershipTransferDto })
  cancelTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('transferId', ParseUUIDPipe) transferId: string,
    @Req() req: Request,
  ) {
    return this.ownership.cancel(user.userId, id, transferId, String(req.id));
  }
}

@ApiTags('clubs')
@ApiBearerAuth()
@Controller('me')
export class ClubsMeController {
  constructor(
    private readonly members: ClubMembersService,
    private readonly ownership: ClubOwnershipService,
  ) {}

  @Get('club-invitations')
  @ApiOperation({ summary: 'Club invitations addressed to me' })
  @ApiOkResponse({ type: MyInvitationPageDto })
  invitations(@CurrentUser() user: AuthUser, @Query() page: PageQuery) {
    return this.members.myInvitations(user.userId, page);
  }

  @Get('ownership-transfers')
  @ApiOperation({ summary: 'Club ownership offers addressed to me' })
  @ApiOkResponse({ type: OwnershipTransferListDto })
  transfers(@CurrentUser() user: AuthUser) {
    return this.ownership.incoming(user.userId);
  }
}
