/** Authenticated caller resolved by {@link AuthGuard}. */
export interface AuthUser {
  userId: string;
  sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: AuthUser;
  }
}
