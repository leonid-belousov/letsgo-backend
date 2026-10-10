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
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { AccountDeletionService } from './account-deletion.service';
import { AdminService } from './admin.service';
import {
  AccountDeletedDto,
  ApproveRecoveryDto,
  AuditPageDto,
  AuditQuery,
  DeclineRecoveryDto,
  DeletionBlockersDto,
  RecoveryApprovalDto,
  RecoveryCasePageDto,
  RecoveryCasesQuery,
  StaffUserPageDto,
  UserLookupQuery,
} from './dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('recovery-cases')
  @ApiOkResponse({ type: RecoveryCasePageDto, description: 'admin.accounts.recover' })
  cases(@CurrentUser() user: AuthUser, @Query() q: RecoveryCasesQuery) {
    return this.admin.recoveryCases(user.userId, q);
  }

  @Post('recovery-cases/:id/approve')
  @HttpCode(200)
  @ApiOkResponse({ type: RecoveryApprovalDto, description: 'Returns the one-time token ONCE' })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRecoveryDto,
    @Req() req: Request,
  ) {
    return this.admin.approveRecovery(user.userId, id, dto.verificationNote, String(req.id));
  }

  @Post('recovery-cases/:id/decline')
  @HttpCode(204)
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineRecoveryDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.admin.declineRecovery(user.userId, id, dto.note, String(req.id));
  }

  @Get('audit')
  @ApiOkResponse({
    type: AuditPageDto,
    description: 'admin.audit.read; newest first; secrets scrubbed',
  })
  audit(@CurrentUser() user: AuthUser, @Query() q: AuditQuery) {
    return this.admin.audit(user.userId, q);
  }

  @Get('users')
  @ApiOkResponse({
    type: StaffUserPageDto,
    description: 'Id / username / status only — no credentials, contacts or DOB',
  })
  users(@CurrentUser() user: AuthUser, @Query() q: UserLookupQuery) {
    return this.admin.users(user.userId, q);
  }
}

@ApiTags('account')
@ApiBearerAuth()
@Controller('me')
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Get('deletion-check')
  @ApiOkResponse({
    type: DeletionBlockersDto,
    description: 'What must be resolved before the account can be deleted',
  })
  check(@CurrentUser() user: AuthUser) {
    return this.deletion.check(user.userId);
  }

  @Delete()
  @ApiOkResponse({
    type: AccountDeletedDto,
    description:
      '409 CONFLICT with lists (ownedClubs, upcomingGames, openObligations, pendingRefunds) when blocked',
  })
  remove(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.deletion.deleteAccount(user.userId, String(req.id));
  }
}
