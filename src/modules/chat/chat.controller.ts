import { UnreadCountDto } from '../../common/pagination/unread-count.dto';
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
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { ChatService } from './chat.service';
import {
  ConversationDto,
  ConversationPageDto,
  MessageDto,
  MessagePageDto,
  OpenDirectDto,
  SendMessageDto,
} from './dto';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('conversations')
  @ApiOkResponse({
    type: ConversationPageDto,
    description: 'Most recently active first; only conversations you can still read',
  })
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.chat.list(user.userId, q);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  unread(@CurrentUser() user: AuthUser) {
    return this.chat.unreadTotal(user.userId);
  }

  @Post('direct')
  @HttpCode(200)
  @ApiOkResponse({
    type: ConversationDto,
    description: 'Opens (or reuses) a personal chat if the recipient’s message policy allows you',
  })
  direct(@CurrentUser() user: AuthUser, @Body() dto: OpenDirectDto) {
    return this.chat.openDirect(user.userId, dto.userId);
  }

  @Post('games/:eventId/contact-organiser')
  @HttpCode(200)
  @ApiOkResponse({
    type: ConversationDto,
    description: 'For pending/waitlisted/invited players who cannot read the squad chat',
  })
  contactOrganiser(
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    return this.chat.contactOrganiser(user.userId, eventId);
  }

  @Get('games/:eventId')
  @ApiOkResponse({
    type: ConversationDto,
    description: 'Game chat — confirmed players and staff only',
  })
  game(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.chat.eventConversation(user.userId, eventId);
  }

  @Get('clubs/:clubId')
  @ApiOkResponse({ type: ConversationDto })
  club(@CurrentUser() user: AuthUser, @Param('clubId', ParseUUIDPipe) clubId: string) {
    return this.chat.clubConversation(user.userId, clubId);
  }

  @Get('tournaments/:tournamentId')
  @ApiOkResponse({
    type: ConversationDto,
    description: 'Announcements: readable by entrants, writable by organisers',
  })
  tournament(@CurrentUser() user: AuthUser, @Param('tournamentId', ParseUUIDPipe) id: string) {
    return this.chat.tournamentConversation(user.userId, id);
  }

  @Get('conversations/:id/messages')
  @ApiOkResponse({
    type: MessagePageDto,
    description: 'Newest first, keyset paginated; access re-checked on every call',
  })
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PageQuery,
  ) {
    return this.chat.messages(user.userId, id, q);
  }

  @Post('conversations/:id/messages')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: MessageDto,
    description: '403 ACCESS_DENIED once you have lost access (even if you still know the id)',
  })
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.chat.send(user.userId, id, dto.body, key);
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.chat.markRead(user.userId, id);
  }

  @Patch('messages/:id')
  @ApiOkResponse({ type: MessageDto })
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chat.edit(user.userId, id, dto.body);
  }

  @Delete('messages/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.chat.remove(user.userId, id);
  }
}
