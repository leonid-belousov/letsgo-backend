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
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { AchievementsService } from './achievements.service';
import {
  AchievementsQuery,
  GrantAchievementDto,
  RevokeAchievementDto,
  StaffAchievementDto,
  UserAchievementsDto,
} from './dto';

@ApiTags('achievements')
@ApiBearerAuth()
@Controller()
export class AchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Public()
  @Get('users/:id/achievements')
  @ApiOkResponse({
    type: UserAchievementsDto,
    description: 'Honours the owner’s awards audience; hidden ⇒ { hidden: true } without a list',
  })
  list(
    @OptionalUser() viewer: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: AchievementsQuery,
  ) {
    return this.achievements.listForUser(viewer?.userId ?? null, id, q);
  }

  @Post('admin/achievements')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({
    type: StaffAchievementDto,
    description:
      'Staff grant of FAIR_PLAY / LEADERSHIP / TROPHY with a reason (admin.achievements.grant)',
  })
  grant(
    @CurrentUser() user: AuthUser,
    @Body() dto: GrantAchievementDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.achievements.grant(user.userId, dto, key, String(req.id));
  }

  @Post('admin/achievements/:id/revoke')
  @HttpCode(200)
  @ApiOkResponse({ type: StaffAchievementDto })
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeAchievementDto,
    @Req() req: Request,
  ) {
    return this.achievements.revoke(user.userId, id, dto.reason, String(req.id));
  }
}
