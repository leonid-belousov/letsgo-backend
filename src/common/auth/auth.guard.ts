import { CanActivate, ExecutionContext, Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ApiError, ErrorCode } from '../errors';
import { Clock } from '../time/clock';
import { PUBLIC_KEY } from './auth.decorators';
import type { AuthUser } from './auth.types';

interface AccessClaims {
  sub: string;
  sid: string;
}

/**
 * Global guard. Verifies the JWT **and** the backing Session row on every request, so
 * revocation (logout, logout-all, refresh-token reuse, suspension) is immediate.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req.headers.authorization);

    if (!token) {
      if (isPublic) return true;
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    }

    const user = await this.resolve(token);
    if (!user) {
      if (isPublic) return true; // invalid token on an optional route behaves like a visitor
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid or expired session');
    }
    req.authUser = user;
    return true;
  }

  private async resolve(token: string): Promise<AuthUser | null> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token);
    } catch {
      return null;
    }
    if (!claims.sub || !claims.sid) return null;
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { status: true } },
      },
    });
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt ||
      session.expiresAt <= this.clock.now() ||
      session.user.status !== 'ACTIVE'
    ) {
      return null;
    }
    return { userId: claims.sub, sessionId: claims.sid };
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [AuthGuard],
  exports: [AuthGuard, JwtModule],
})
export class AuthKernelModule {}
