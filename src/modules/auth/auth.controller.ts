import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { AuthService, type DeviceInfo } from './auth.service';
import { AuthNonceService } from './nonce.service';
import {
  ChangePasswordDto,
  IdentityDto,
  LinkProviderDto,
  LoginDto,
  NonceDto,
  ProviderLoginDto,
  RecoveryRedeemDto,
  RecoveryRequestDto,
  RefreshDto,
  RegisterDto,
  SessionDto,
  TokenPairDto,
} from './dto';
import { RecoveryService } from './recovery.service';

const device = (req: Request, name?: string): DeviceInfo => ({
  deviceName: name,
  userAgent: req.headers['user-agent'],
});

const strict = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: RecoveryService,
    private readonly nonces: AuthNonceService,
  ) {}

  @Public()
  @Throttle(strict)
  @Post('register')
  @ApiOkResponse({
    type: TokenPairDto,
    description: 'Creates the account and a device session. No OTP step.',
  })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, dto.password, device(req, dto.deviceName));
  }

  @Public()
  @Throttle(strict)
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenPairDto })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, dto.password, device(req, dto.deviceName));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('nonce')
  @HttpCode(200)
  @ApiOkResponse({
    type: NonceDto,
    description:
      'Single-use server nonce (256-bit, valid 10 minutes) that the Google/Apple ID token must carry',
  })
  async nonce(): Promise<NonceDto> {
    const n = await this.nonces.issue();
    return { nonce: n.nonce, expiresAt: n.expiresAt.toISOString() };
  }

  @Public()
  @Throttle(strict)
  @Post('google')
  @HttpCode(200)
  @ApiOkResponse({
    type: TokenPairDto,
    description:
      '503 PROVIDER_UNAVAILABLE (details.reason PROVIDER_NOT_CONFIGURED) until GOOGLE_CLIENT_IDS is set',
  })
  google(@Body() dto: ProviderLoginDto, @Req() req: Request) {
    return this.auth.providerLogin(
      'GOOGLE',
      dto.idToken,
      dto.nonce,
      device(req, dto.deviceName),
      String(req.id),
    );
  }

  @Public()
  @Throttle(strict)
  @Post('apple')
  @HttpCode(200)
  @ApiOkResponse({
    type: TokenPairDto,
    description:
      '503 PROVIDER_UNAVAILABLE (details.reason PROVIDER_NOT_CONFIGURED) until APPLE_CLIENT_IDS is set',
  })
  apple(@Body() dto: ProviderLoginDto, @Req() req: Request) {
    return this.auth.providerLogin(
      'APPLE',
      dto.idToken,
      dto.nonce,
      device(req, dto.deviceName),
      String(req.id),
    );
  }

  @ApiBearerAuth()
  @Throttle(strict)
  @Post('link/google')
  @ApiCreatedResponse({
    type: IdentityDto,
    description: 'Links a Google identity to the current account; 409 if it belongs to another',
  })
  linkGoogle(@CurrentUser() user: AuthUser, @Body() dto: LinkProviderDto, @Req() req: Request) {
    return this.auth.linkProvider(user.userId, 'GOOGLE', dto.idToken, dto.nonce, String(req.id));
  }

  @ApiBearerAuth()
  @Throttle(strict)
  @Post('link/apple')
  @ApiCreatedResponse({
    type: IdentityDto,
    description: 'Links an Apple identity to the current account; 409 if it belongs to another',
  })
  linkApple(@CurrentUser() user: AuthUser, @Body() dto: LinkProviderDto, @Req() req: Request) {
    return this.auth.linkProvider(user.userId, 'APPLE', dto.idToken, dto.nonce, String(req.id));
  }

  @ApiBearerAuth()
  @Get('identities')
  @ApiOkResponse({ type: [IdentityDto], description: 'Login methods of the current account' })
  identities(@CurrentUser() user: AuthUser) {
    return this.auth.listIdentities(user.userId);
  }

  @ApiBearerAuth()
  @Throttle(strict)
  @Delete('identities/:id')
  @HttpCode(204)
  async unlink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.unlinkIdentity(user.userId, id, String(req.id));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({
    type: TokenPairDto,
    description: 'Rotates the refresh token; replaying an old one revokes the session',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, device(req));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user.userId, user.sessionId);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.logoutAll(user.userId, String(req.id));
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOkResponse({ type: [SessionDto] })
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.userId, user.sessionId);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.auth.revokeSession(user.userId, id);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.changePassword(
      user.userId,
      user.sessionId,
      dto.currentPassword,
      dto.newPassword,
      String(req.id),
    );
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('recovery/request')
  @HttpCode(202)
  async recoveryRequest(@Body() dto: RecoveryRequestDto): Promise<{ accepted: true }> {
    await this.recovery.request(dto, dto.message);
    return { accepted: true };
  }

  @Public()
  @Throttle(strict)
  @Post('recovery/redeem')
  @HttpCode(204)
  async recoveryRedeem(@Body() dto: RecoveryRedeemDto): Promise<void> {
    await this.recovery.redeem(dto.token, dto.newPassword);
  }
}
