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
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  AdminReportDetailDto,
  AdminReportDto,
  AdminReportPageDto,
  ApplyModerationActionDto,
  CreateReportDto,
  ModerationActionDto,
  MyReportsPageDto,
  MyReportsQuery,
  ReportQueueQuery,
  ReportReceiptDto,
  ResolveReportDto,
} from './dto';
import { ModerationService } from './moderation.service';

const idem = { name: 'Idempotency-Key', required: false };

@ApiTags('moderation')
@ApiBearerAuth()
@Controller()
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('reports')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ReportReceiptDto,
    description: 'Report sent. Removal is never promised; nothing is blocked.',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReportDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.moderation.create(user.userId, dto, key);
  }

  @Get('reports/mine')
  @ApiOkResponse({ type: MyReportsPageDto })
  mine(@CurrentUser() user: AuthUser, @Query() q: MyReportsQuery) {
    return this.moderation.mine(user.userId, q);
  }

  @Get('admin/reports')
  @ApiOkResponse({
    type: AdminReportPageDto,
    description: 'Queue, oldest first (admin.reports.moderate)',
  })
  queue(@CurrentUser() user: AuthUser, @Query() q: ReportQueueQuery) {
    return this.moderation.queue(user.userId, q);
  }

  @Get('admin/reports/:id')
  @ApiOkResponse({ type: AdminReportDetailDto, description: 'Every read is audited' })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.moderation.detail(user.userId, id, String(req.id));
  }

  @Post('admin/reports/:id/take')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminReportDto })
  take(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.moderation.take(user.userId, id, String(req.id));
  }

  @Post('admin/reports/:id/resolve')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminReportDto })
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
    @Req() req: Request,
  ) {
    return this.moderation.close(user.userId, id, 'RESOLVED', dto.resolution, String(req.id));
  }

  @Post('admin/reports/:id/dismiss')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminReportDto })
  dismiss(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
    @Req() req: Request,
  ) {
    return this.moderation.close(user.userId, id, 'DISMISSED', dto.resolution, String(req.id));
  }

  @Post('admin/moderation/actions')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ModerationActionDto,
    description:
      'HIDE_POST, REMOVE_COMMENT, REMOVE_MEDIA, SUSPEND_USER, RESTORE_USER, WARN; reason mandatory',
  })
  apply(
    @CurrentUser() user: AuthUser,
    @Body() dto: ApplyModerationActionDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.moderation.apply(user.userId, dto, key, String(req.id));
  }
}
