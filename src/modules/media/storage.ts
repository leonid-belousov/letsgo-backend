import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';

export class UploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`upload exceeds ${maxBytes} bytes`);
  }
}

export interface StoredObject {
  sizeBytes: number;
  sha256: string;
  /** First bytes of the content (for magic-number sniffing). */
  head: Buffer;
}

/**
 * Storage abstraction for media bytes. TECH/dev only: the production provider is an OPEN
 * decision, so nothing outside this file knows where bytes live.
 */
export abstract class MediaStorage {
  /** Streams `source` into storage, aborting with {@link UploadTooLargeError} above `maxBytes`. */
  abstract write(key: string, source: Readable, maxBytes: number): Promise<StoredObject>;
  abstract read(key: string): Promise<{ stream: Readable; sizeBytes: number }>;
  abstract exists(key: string): Promise<boolean>;
  abstract delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/** Writes under env MEDIA_LOCAL_DIR. Development / test storage. */
@Injectable()
export class LocalDiskStorage extends MediaStorage {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.root = path.resolve(config.get('MEDIA_LOCAL_DIR', { infer: true }));
  }

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('invalid storage key');
    return path.join(this.root, ...key.split('/'));
  }

  async write(key: string, source: Readable, maxBytes: number): Promise<StoredObject> {
    const target = this.resolve(key);
    const part = `${target}.part`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new UploadTooLargeError(maxBytes));
          return;
        }
        if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(part));
      await fs.rename(part, target);
    } catch (err) {
      await fs.rm(part, { force: true });
      throw err;
    }
    return { sizeBytes: size, sha256: hash.digest('hex'), head };
  }

  async read(key: string): Promise<{ stream: Readable; sizeBytes: number }> {
    const file = this.resolve(key);
    const stat = await fs.stat(file);
    return { stream: createReadStream(file), sizeBytes: stat.size };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}
