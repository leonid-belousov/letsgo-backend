import { UnreadCountDto } from '../../common/pagination/unread-count.dto';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { ActivityPageDto, ActivityQuery, ActivityService, MarkReadDto } from './activity.service';

@ApiTags('activity')
@ApiBearerAuth()
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @ApiOkResponse({ type: ActivityPageDto, description: 'Newest first, keyset paginated' })
  list(@CurrentUser() user: AuthUser, @Query() q: ActivityQuery) {
    return this.activity.list(user.userId, q);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  unread(@CurrentUser() user: AuthUser) {
    return this.activity.unreadCount(user.userId);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOkResponse({
    description: 'Marks items read. Never accepts an invitation or performs the action.',
  })
  read(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto) {
    return this.activity.markRead(user.userId, dto.ids);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser) {
    return this.activity.markAllRead(user.userId);
  }
}
