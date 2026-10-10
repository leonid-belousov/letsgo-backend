import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { BlockedUserDto, PrivacyDto, UpdatePrivacyDto } from './dto';
import { PrivacyService } from './privacy.service';

@ApiTags('privacy')
@ApiBearerAuth()
@Controller()
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('me/privacy')
  @ApiOkResponse({ type: PrivacyDto })
  get(@CurrentUser() user: AuthUser) {
    return this.privacy.get(user.userId);
  }

  @Patch('me/privacy')
  @ApiOkResponse({ type: PrivacyDto })
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdatePrivacyDto, @Req() req: Request) {
    return this.privacy.update(user.userId, dto, String(req.id));
  }

  @Get('me/blocks')
  @ApiOkResponse({ type: [BlockedUserDto] })
  blocks(@CurrentUser() user: AuthUser) {
    return this.privacy.listBlocked(user.userId);
  }

  @Put('blocks/:userId')
  @HttpCode(204)
  async block(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.privacy.block(user.userId, userId);
  }

  @Delete('blocks/:userId')
  @HttpCode(204)
  async unblock(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.privacy.unblock(user.userId, userId);
  }
}
