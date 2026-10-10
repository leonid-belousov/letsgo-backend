import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { PolicyService } from '../../common/permissions/policy.service';
import { MaintenanceService } from './maintenance.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly policy: PolicyService,
  ) {}

  @Post('run')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      'Runs the persistent maintenance job once (deadlines, holds, offers, auto-cancel, next waves, push retries, cleanup). Safe to call repeatedly and concurrently: overlapping calls report SKIPPED.',
  })
  async run(@CurrentUser() user: AuthUser) {
    await this.policy.assert(user.userId, 'admin.maintenance.run', { type: 'PLATFORM' });
    return this.maintenance.runOnce();
  }

  @Get('runs')
  @ApiOkResponse({ description: 'Recent executions with their reports' })
  async runs(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    await this.policy.assert(user.userId, 'admin.maintenance.run', { type: 'PLATFORM' });
    return this.maintenance.recentRuns(limit ? Number(limit) : 20);
  }
}
