import { UnreadCountDto } from '../../common/pagination/unread-count.dto';
import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { PageQuery } from '../../common/pagination/cursor-page';
import { MarkReadDto } from '../activity/activity.service';
import {
  NotificationPageDto,
  NotificationsService,
  PreferenceDto,
  UpdatePreferenceDto,
} from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOkResponse({ type: NotificationPageDto })
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.notifications.list(user.userId, q);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  unread(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.userId);
  }

  @Post('read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(user.userId, dto.ids);
  }

  @Get('preferences')
  @ApiOkResponse({
    type: [PreferenceDto],
    description: 'Push is separate from Follow; social updates default to no push',
  })
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.preferences(user.userId);
  }

  @Put('preferences')
  @ApiOkResponse({ type: PreferenceDto })
  setPreference(@CurrentUser() user: AuthUser, @Body() dto: UpdatePreferenceDto) {
    return this.notifications.setPreference(user.userId, dto);
  }
}
