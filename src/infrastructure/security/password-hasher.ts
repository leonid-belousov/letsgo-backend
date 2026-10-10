import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LEN = 32;
const R = 8;
const P = 1;

/** SHA-256 hex of a high-entropy secret (refresh/recovery tokens). Not for passwords. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 256-bit URL-safe random secret. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Password hashing with scrypt from node:crypto (TECH decision: OWASP-listed, maintained
 * by Node core, no native addon / extra dependency). Format:
 *   scrypt$<logN>$<r>$<p>$<saltB64>$<hashB64>
 * The parameters are stored per hash so cost can be raised later (needsRehash).
 */
@Injectable()
export class PasswordHasher {
  private readonly logN: number;

  constructor(config: ConfigService<Env, true>) {
    this.logN = config.get('PASSWORD_SCRYPT_LOG_N', { infer: true });
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const N = 2 ** this.logN;
    const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
      N,
      r: R,
      p: P,
      maxmem: 256 * N * R,
    });
    return `scrypt$${this.logN}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, logN, r, p, saltB64, hashB64] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const N = 2 ** Number(logN);
    if (!Number.isInteger(N) || N < 1024 || N > 2 ** 22) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltB64, 'base64'),
      expected.length,
      {
        N,
        r: Number(r),
        p: Number(p),
        maxmem: 256 * N * Number(r),
      },
    );
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  needsRehash(stored: string): boolean {
    return !stored.startsWith(`scrypt$${this.logN}$${R}$${P}$`);
  }
}

@Global()
@Module({ providers: [PasswordHasher], exports: [PasswordHasher] })
export class SecurityModule {}
