import { createHash } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError, ErrorCode } from '../../common/errors';

export type ProviderName = 'GOOGLE' | 'APPLE';

export interface VerifiedProviderIdentity {
  /** Stable provider user id (`sub`). The only claim ever used to identify an account. */
  subject: string;
  /** Informational only. Never used for matching, merging or lookups (Handoff §18). */
  email?: string;
}

/** Injection token for the per-provider JWKS key resolvers (production: remote + cached). */
export const PROVIDER_JWKS = Symbol('PROVIDER_JWKS');
export type ProviderJwks = Record<ProviderName, JWTVerifyGetKey>;

const LABEL: Record<ProviderName, string> = { GOOGLE: 'Google', APPLE: 'Apple' };

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/** Production JWKS resolvers: fetched lazily on first use, cached, cooldown-limited. */
export function remoteProviderJwks(): ProviderJwks {
  const opts = { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 };
  return {
    GOOGLE: createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), opts),
    APPLE: createRemoteJWKSet(new URL(APPLE_JWKS_URL), opts),
  };
}

export function notConfigured(provider: ProviderName): ApiError {
  return new ApiError(
    ErrorCode.PROVIDER_UNAVAILABLE,
    `${LABEL[provider]} sign-in is not configured`,
    { provider, reason: 'PROVIDER_NOT_CONFIGURED' },
  );
}

/**
 * Provider (Google / Apple) ID-token verification. `nonce` is the raw server-issued nonce the
 * token must be bound to.
 */
export abstract class ProviderVerifier {
  abstract isConfigured(provider: ProviderName): boolean;
  abstract verify(
    provider: ProviderName,
    idToken: string,
    nonce: string,
  ): Promise<VerifiedProviderIdentity>;
}

/** Adapter for a provider whose client-id list is empty: honest 503, never a fake success. */
export class UnconfiguredProviderVerifier extends ProviderVerifier {
  isConfigured(): boolean {
    return false;
  }
  verify(provider: ProviderName): Promise<VerifiedProviderIdentity> {
    return Promise.reject(notConfigured(provider));
  }
}

export interface IdTokenVerifierOptions {
  provider: ProviderName;
  issuers: string[];
  audiences: string[];
  jwks: JWTVerifyGetKey;
  now: () => Date;
  /** Does the ID token's `nonce` claim match the server nonce? */
  nonceMatches: (claim: string, nonce: string) => boolean;
}

const CLOCK_TOLERANCE_S = 30;
const MAX_TOKEN_AGE = '1 day';

const sha256HexLower = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Google: the `nonce` claim is the raw nonce. */
export const googleNonceMatches = (claim: string, nonce: string): boolean => claim === nonce;
/** Apple: iOS clients send sha256(nonce) hex to Apple, which echoes it; web flows echo it raw. */
export const appleNonceMatches = (claim: string, nonce: string): boolean =>
  claim === nonce || claim.toLowerCase() === sha256HexLower(nonce);

/** Marks a failure to obtain the provider's signing keys (network / timeout), as opposed to a bad token. */
class KeysUnreachableError extends Error {}

const isKeyFetchFailure = (e: unknown): boolean =>
  e instanceof errors.JWKSTimeout ||
  !(e instanceof errors.JOSEError) ||
  e.code === 'ERR_JOSE_GENERIC';

/** Signature, issuer, audience, expiry and nonce verification for one OIDC provider (jose). */
export class IdTokenVerifier extends ProviderVerifier {
  constructor(private readonly opts: IdTokenVerifierOptions) {
    super();
  }

  isConfigured(): boolean {
    return this.opts.audiences.length > 0;
  }

  async verify(
    provider: ProviderName,
    idToken: string,
    nonce: string,
  ): Promise<VerifiedProviderIdentity> {
    const { opts } = this;
    if (opts.audiences.length === 0) throw notConfigured(provider);
    const now = opts.now();
    let payload;
    try {
      const keys: JWTVerifyGetKey = async (header, token) => {
        try {
          return await opts.jwks(header, token);
        } catch (e) {
          if (isKeyFetchFailure(e)) throw new KeysUnreachableError('signing keys unreachable');
          throw e;
        }
      };
      ({ payload } = await jwtVerify(idToken, keys, {
        algorithms: ['RS256'],
        issuer: opts.issuers,
        audience: opts.audiences,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: CLOCK_TOLERANCE_S,
        maxTokenAge: MAX_TOKEN_AGE,
        currentDate: now,
      }));
    } catch (e) {
      throw this.mapError(e);
    }
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255) {
      throw this.invalid('SUBJECT_INVALID');
    }
    if (typeof payload.nonce !== 'string' || !opts.nonceMatches(payload.nonce, nonce)) {
      throw this.invalid('NONCE_MISMATCH');
    }
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    return { subject, email };
  }

  private invalid(reason: string): ApiError {
    return new ApiError(
      ErrorCode.UNAUTHENTICATED,
      `${LABEL[this.opts.provider]} sign-in token is invalid`,
      { reason },
    );
  }

  private mapError(e: unknown): ApiError {
    if (e instanceof errors.JWTExpired) return this.invalid('TOKEN_EXPIRED');
    if (e instanceof errors.JWTClaimValidationFailed) return this.invalid('CLAIM_INVALID');
    // Key material could not be obtained: an outage on the provider's side, not a bad token.
    if (e instanceof KeysUnreachableError) {
      return new ApiError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `${LABEL[this.opts.provider]} sign-in is temporarily unavailable`,
        { provider: this.opts.provider, reason: 'PROVIDER_KEYS_UNREACHABLE' },
      );
    }
    return this.invalid('TOKEN_INVALID');
  }
}

/** Routes each provider to its adapter (configured or not). */
export class CompositeProviderVerifier extends ProviderVerifier {
  constructor(private readonly adapters: Record<ProviderName, ProviderVerifier>) {
    super();
  }
  isConfigured(provider: ProviderName): boolean {
    return this.adapters[provider].isConfigured(provider);
  }
  verify(
    provider: ProviderName,
    idToken: string,
    nonce: string,
  ): Promise<VerifiedProviderIdentity> {
    return this.adapters[provider].verify(provider, idToken, nonce);
  }
}
