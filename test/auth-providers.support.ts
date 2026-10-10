import { createHash, randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import type { ProviderJwks } from '../src/modules/auth/provider-verifier';
import type { TestApp } from './support/app';
import { uniq } from './support/factories';

export const GOOGLE_AUD = 'test-google-client.apps.example.test';
export const APPLE_AUD = 'test.example.letsgo.ios';
export const GOOGLE_ISS = 'https://accounts.google.com';
export const APPLE_ISS = 'https://appleid.apple.com';

export interface KeyPairs {
  jwks: ProviderJwks;
  google: { kid: string; privateKey: KeyLike };
  apple: { kid: string; privateKey: KeyLike };
  /** A key the JWKS does NOT contain (attacker) - claims the same kid. */
  rogue: { privateKey: KeyLike };
}

async function makeSet(kid: string): Promise<{ privateKey: KeyLike; set: { keys: JWK[] } }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  return { privateKey, set: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] } };
}

/** Locally generated provider keys + JWKS resolvers (no network, no real credentials). */
export async function makeKeyPairs(): Promise<KeyPairs> {
  const g = await makeSet('google-test-kid');
  const a = await makeSet('apple-test-kid');
  const rogue = await generateKeyPair('RS256');
  return {
    jwks: { GOOGLE: createLocalJWKSet(g.set), APPLE: createLocalJWKSet(a.set) },
    google: { kid: 'google-test-kid', privateKey: g.privateKey },
    apple: { kid: 'apple-test-kid', privateKey: a.privateKey },
    rogue: { privateKey: rogue.privateKey },
  };
}

export interface TokenOptions {
  key: KeyLike;
  kid: string;
  iss: string;
  aud: string | string[];
  /** Omit the subject claim entirely with `null`. */
  sub?: string | null;
  /** `undefined` => no nonce claim. */
  nonce?: string;
  iat?: number;
  exp?: number;
  alg?: string;
  extra?: JWTPayload;
}

const nowS = (): number => Math.floor(Date.now() / 1000);

export async function signIdToken(o: TokenOptions): Promise<string> {
  const jwt = new SignJWT({ ...(o.nonce === undefined ? {} : { nonce: o.nonce }), ...o.extra })
    .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: o.kid, typ: 'JWT' })
    .setIssuer(o.iss)
    .setAudience(o.aud)
    .setIssuedAt(o.iat ?? nowS() - 5)
    .setExpirationTime(o.exp ?? nowS() + 600);
  if (o.sub !== null) jwt.setSubject(o.sub ?? `sub-${uniq(12)}`);
  return jwt.sign(o.key);
}

/** Unsigned token with `alg: none`. */
export function unsignedToken(payload: Record<string, unknown>): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.`;
}

export const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');
export const randomSubject = (): string => `sub-${randomBytes(8).toString('hex')}`;

export async function getNonce(t: TestApp): Promise<{ nonce: string; expiresAt: string }> {
  const res = await t.http().post('/v1/auth/nonce').expect(200);
  return res.body as { nonce: string; expiresAt: string };
}
