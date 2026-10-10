import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, ErrorCode } from '../errors';
import type { AuthUser } from './auth.types';

export const PUBLIC_KEY = 'letsgo:public';

/**
 * Authentication optional: the route is reachable without a token (visitors, login, register),
 * but a valid token is still resolved so responses can be viewer-aware.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** The authenticated caller; throws UNAUTHENTICATED when absent. */
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<Request>().authUser;
  if (!user) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
  return user;
});

/** The caller if a valid token was supplied, otherwise null (use with @Public()). */
export const OptionalUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthUser | null =>
    ctx.switchToHttp().getRequest<Request>().authUser ?? null,
);
