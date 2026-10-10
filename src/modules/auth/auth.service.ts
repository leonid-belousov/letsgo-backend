import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthProvider, Session } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import { isUniqueViolation, type Tx } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  PasswordHasher,
  randomSecret,
  sha256Hex,
} from '../../infrastructure/security/password-hasher';
import type { ContactDto, IdentityDto, SessionDto, TokenPairDto } from './dto';
import { AuthNonceService } from './nonce.service';
import { notConfigured, ProviderVerifier, type ProviderName } from './provider-verifier';

export interface DeviceInfo {
  deviceName?: string;
  userAgent?: string;
}

export function normalizeContact(contact: ContactDto): { provider: AuthProvider; subject: string } {
  if (contact.email) return { provider: 'EMAIL', subject: contact.email.trim().toLowerCase() };
  if (contact.phone) return { provider: 'PHONE', subject: contact.phone.trim() };
  throw new ApiError(ErrorCode.VALIDATION, 'email or phone is required');
}

/** A login method that can authenticate on its own: a password or a Google/Apple identity. */
function isUsableLogin(i: { provider: AuthProvider; passwordHash: string | null }): boolean {
  return i.passwordHash !== null || i.provider === 'GOOGLE' || i.provider === 'APPLE';
}

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly providers: ProviderVerifier,
    private readonly nonces: AuthNonceService,
  ) {}

  private assertPasswordPolicy(password: string): void {
    const min = this.config.get('PASSWORD_MIN_LENGTH', { infer: true });
    // OPEN #3: only a length floor is enforced; no composition rules are invented.
    if (password.length < min) {
      throw new ApiError(ErrorCode.VALIDATION, `Password must be at least ${min} characters`, {
        field: 'password',
      });
    }
  }

  async register(contact: ContactDto, password: string, device: DeviceInfo): Promise<TokenPairDto> {
    this.assertPasswordPolicy(password);
    const { provider, subject } = normalizeContact(contact);
    const passwordHash = await this.hasher.hash(password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            profile: { create: {} },
            privacy: { create: {} },
            identities: { create: { provider, subject, passwordHash } },
          },
        });
        return this.issueSession(tx, user.id, device);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ApiError(ErrorCode.CONFLICT, 'This contact is already registered', {
          field: provider === 'EMAIL' ? 'email' : 'phone',
        });
      }
      throw e;
    }
  }

  async login(contact: ContactDto, password: string, device: DeviceInfo): Promise<TokenPairDto> {
    const { provider, subject } = normalizeContact(contact);
    const identity = await this.prisma.authIdentity.findUnique({
      where: { provider_subject: { provider, subject } },
      include: { user: { select: { status: true } } },
    });
    // Always burn one hash verification so unknown accounts are not distinguishable by timing.
    const stored = identity?.passwordHash ?? (await this.getDummyHash());
    const ok = await this.hasher.verify(password, stored);
    if (!identity || !identity.passwordHash || !ok || identity.user.status !== 'ACTIVE') {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid credentials');
    }
    if (this.hasher.needsRehash(identity.passwordHash)) {
      const fresh = await this.hasher.hash(password);
      await this.prisma.authIdentity.update({
        where: { id: identity.id },
        data: { passwordHash: fresh },
      });
    }
    return this.prisma.$transaction((tx) => this.issueSession(tx, identity.userId, device));
  }

  /** Fails with 503 when the provider has no client ids, 400 when the nonce is missing. */
  private requireNonce(provider: ProviderName, nonce: string | undefined): string {
    if (!this.providers.isConfigured(provider)) throw notConfigured(provider);
    if (!nonce) {
      throw new ApiError(ErrorCode.VALIDATION, 'nonce is required (POST /auth/nonce)', {
        field: 'nonce',
      });
    }
    return nonce;
  }

  private async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
  }

  /**
   * Sign in with a verified provider identity. An existing identity signs in; an unknown one
   * creates its own account. Never matched by e-mail (Handoff §18).
   */
  async providerLogin(
    provider: ProviderName,
    idToken: string,
    nonce: string | undefined,
    device: DeviceInfo,
    requestId?: string,
  ): Promise<TokenPairDto> {
    const rawNonce = this.requireNonce(provider, nonce);
    const verified = await this.providers.verify(provider, idToken, rawNonce);
    const attempt = (): Promise<TokenPairDto> =>
      this.prisma.$transaction(async (tx) => {
        // Consumed in the same transaction: any failure below rolls the nonce back, and two
        // parallel requests with one nonce cannot both pass.
        await this.nonces.consume(tx, rawNonce);
        const existing = await tx.authIdentity.findUnique({
          where: { provider_subject: { provider, subject: verified.subject } },
          include: { user: { select: { status: true } } },
        });
        if (existing) {
          if (existing.user.status !== 'ACTIVE') {
            throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Account unavailable');
          }
          return this.issueSession(tx, existing.userId, device);
        }
        const user = await tx.user.create({
          data: {
            profile: { create: {} },
            privacy: { create: {} },
            identities: {
              create: { provider, subject: verified.subject, verifiedAt: this.clock.now() },
            },
          },
          include: { identities: { select: { id: true } } },
        });
        await this.audit.record(tx, {
          actorId: user.id,
          action: 'auth.provider_login_created',
          targetType: 'AuthIdentity',
          targetId: user.identities[0]?.id ?? null,
          requestId,
          metadata: { provider },
        });
        return this.issueSession(tx, user.id, device);
      });
    try {
      return await attempt();
    } catch (e) {
      // Two first sign-ins of the same subject raced on the unique index: the loser signs in.
      if (isUniqueViolation(e)) return attempt();
      throw e;
    }
  }

  /** Explicit, audited linking of a provider identity to the logged-in account. Never steals. */
  async linkProvider(
    userId: string,
    provider: ProviderName,
    idToken: string,
    nonce: string | undefined,
    requestId?: string,
  ): Promise<IdentityDto> {
    const rawNonce = this.requireNonce(provider, nonce);
    const verified = await this.providers.verify(provider, idToken, rawNonce);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockUser(tx, userId);
        await this.nonces.consume(tx, rawNonce);
        const existing = await tx.authIdentity.findUnique({
          where: { provider_subject: { provider, subject: verified.subject } },
          select: { userId: true },
        });
        if (existing) {
          const own = existing.userId === userId;
          throw new ApiError(
            ErrorCode.CONFLICT,
            own
              ? 'This identity is already linked to your account'
              : 'This identity is already linked to another account',
            { reason: own ? 'IDENTITY_ALREADY_LINKED' : 'IDENTITY_LINKED_TO_ANOTHER_ACCOUNT' },
          );
        }
        const sameProvider = await tx.authIdentity.findFirst({
          where: { userId, provider },
          select: { id: true },
        });
        if (sameProvider) {
          throw new ApiError(ErrorCode.CONFLICT, 'A different account of this provider is linked', {
            reason: 'PROVIDER_ALREADY_LINKED',
          });
        }
        const created = await tx.authIdentity.create({
          data: { userId, provider, subject: verified.subject, verifiedAt: this.clock.now() },
        });
        await this.audit.record(tx, {
          actorId: userId,
          action: 'auth.provider_linked',
          targetType: 'AuthIdentity',
          targetId: created.id,
          requestId,
          metadata: { provider },
        });
        return {
          id: created.id,
          provider,
          linkedAt: created.createdAt.toISOString(),
          hasPassword: false,
          canUnlink: true,
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ApiError(ErrorCode.CONFLICT, 'This identity is already linked to an account', {
          reason: 'IDENTITY_LINKED_TO_ANOTHER_ACCOUNT',
        });
      }
      throw e;
    }
  }

  async listIdentities(userId: string): Promise<IdentityDto[]> {
    const rows = await this.prisma.authIdentity.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, provider: true, passwordHash: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      linkedAt: r.createdAt.toISOString(),
      hasPassword: r.passwordHash !== null,
      canUnlink: rows.some((o) => o.id !== r.id && isUsableLogin(o)),
    }));
  }

  /** Removes a login method, but never the last usable one (password or provider). */
  async unlinkIdentity(userId: string, identityId: string, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const all = await tx.authIdentity.findMany({
        where: { userId },
        select: { id: true, provider: true, passwordHash: true },
      });
      const target = all.find((i) => i.id === identityId);
      if (!target) throw new ApiError(ErrorCode.NOT_FOUND, 'Identity not found');
      if (!all.some((i) => i.id !== target.id && isUsableLogin(i))) {
        throw new ApiError(ErrorCode.CONFLICT, 'You cannot remove your last login method', {
          reason: 'LAST_LOGIN_METHOD',
        });
      }
      await tx.authIdentity.delete({ where: { id: target.id } });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'auth.provider_unlinked',
        targetType: 'AuthIdentity',
        targetId: target.id,
        requestId,
        metadata: { provider: target.provider },
      });
    });
  }

  async refresh(refreshToken: string, device: DeviceInfo): Promise<TokenPairDto> {
    const hash = sha256Hex(refreshToken);
    const now = this.clock.now();

    // Reuse detection must persist even though the request fails, so it is its own transaction.
    const reuseHandled = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { refreshTokenHash: hash } });
      if (session) return { session, reused: false as const };
      const reused = await tx.session.findUnique({ where: { previousRefreshHash: hash } });
      if (reused && !reused.revokedAt) {
        await tx.session.update({
          where: { id: reused.id },
          data: { revokedAt: now, revokedReason: 'refresh_token_reuse' },
        });
        await this.audit.record(tx, {
          actorId: reused.userId,
          action: 'session.reuse_detected',
          targetType: 'Session',
          targetId: reused.id,
        });
      }
      return { session: null, reused: true as const };
    });
    if (!reuseHandled.session)
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    const session = reuseHandled.session;

    if (session.revokedAt || session.expiresAt <= now) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Session expired');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { status: true },
    });
    if (user?.status !== 'ACTIVE')
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Account unavailable');

    const next = randomSecret();
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
      data: {
        refreshTokenHash: sha256Hex(next),
        previousRefreshHash: hash,
        lastUsedAt: now,
        userAgent: device.userAgent?.slice(0, 300) ?? session.userAgent,
      },
    });
    if (rotated.count !== 1) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    return this.tokenPair(session.userId, session.id, next);
  }

  async logout(userId: string, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: 'logout' },
    });
  }

  async logoutAll(userId: string, requestId?: string): Promise<{ revoked: number }> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'logout_all' },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'session.logout_all',
        targetType: 'User',
        targetId: userId,
        requestId,
        metadata: { revoked: res.count },
      });
      return { revoked: res.count };
    });
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionDto[]> {
    const now = this.clock.now();
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      deviceName: s.deviceName,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: 'revoked_by_user' },
    });
    if (res.count === 0) throw new ApiError(ErrorCode.NOT_FOUND, 'Session not found');
  }

  async changePassword(
    userId: string,
    sessionId: string,
    current: string,
    next: string,
    requestId?: string,
  ): Promise<void> {
    this.assertPasswordPolicy(next);
    const first = await this.prisma.authIdentity.findFirst({
      where: { userId, passwordHash: { not: null } },
    });
    if (!first?.passwordHash || !(await this.hasher.verify(current, first.passwordHash))) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Current password is incorrect');
    }
    const hash = await this.hasher.hash(next);
    await this.prisma.$transaction(async (tx) => {
      await tx.authIdentity.updateMany({
        where: { userId, passwordHash: { not: null } },
        data: { passwordHash: hash },
      });
      await tx.session.updateMany({
        where: { userId, id: { not: sessionId }, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'password_changed' },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'auth.password_changed',
        targetType: 'User',
        targetId: userId,
        requestId,
      });
    });
  }

  // ── internals ──

  async issueSession(tx: Tx, userId: string, device: DeviceInfo): Promise<TokenPairDto> {
    const now = this.clock.now();
    const refresh = randomSecret();
    const days = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    const session: Session = await tx.session.create({
      data: {
        userId,
        refreshTokenHash: sha256Hex(refresh),
        deviceName: device.deviceName?.slice(0, 80) ?? null,
        userAgent: device.userAgent?.slice(0, 300) ?? null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + days * 86_400_000),
      },
    });
    return this.tokenPair(userId, session.id, refresh);
  }

  private async tokenPair(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<TokenPairDto> {
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: sessionId });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }),
      sessionId,
      userId,
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(randomSecret(12));
    return this.dummyHash;
  }
}
