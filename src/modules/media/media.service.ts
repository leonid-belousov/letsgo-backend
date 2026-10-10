import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaAsset, MediaKind, MediaVariant } from '@prisma/client';
import sharp, { type OutputInfo } from 'sharp';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  PageQuery,
} from '../../common/pagination/cursor-page';
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { tournamentIsPublic, PostVisibilityService } from '../posts/post-visibility.service';
import {
  CreateUploadDto,
  MEDIA_LIMITS,
  MEDIA_VARIANTS,
  MediaAssetDto,
  MediaPageDto,
  MediaVariantLabel,
  SignedUrlDto,
} from './dto';
import { assertOwnedReady, MEDIA_DELETED_REASON } from './media-checks';
import { MediaStorage, UploadTooLargeError } from './storage';

type AssetWithVariants = MediaAsset & { variants: MediaVariant[] };
const WITH_VARIANTS = { variants: true } as const;

/** Decompression-bomb guard: images above this many pixels are rejected (about 64 MP). */
export const MAX_INPUT_PIXELS = 64_000_000;
const VARIANT_SPECS: { label: 'thumb' | 'card'; max: number }[] = [
  { label: 'thumb', max: 320 },
  { label: 'card', max: 800 },
];
const SHARP_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Lifetime of a signed content URL (hard cap: 5 minutes). */
export const SIGNED_URL_TTL_SECONDS = 300;
const HKDF_INFO = 'letsgo/media-url/v1';
const NOT_AVAILABLE = 'This content isn’t available';

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => head[offset + i] === b);
}

/** Magic-number check so a renamed executable cannot pass as an image. */
function sniffMatches(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/webp':
      return (
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'image/heic':
    case 'video/mp4':
      return startsWith(head, [0x66, 0x74, 0x79, 0x70], 4);
    case 'video/quicktime': {
      const box = head.subarray(4, 8).toString('latin1');
      return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box);
    }
    case 'video/webm':
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'application/pdf':
      return startsWith(head, [0x25, 0x50, 0x44, 0x46]);
    default:
      return false;
  }
}

@Injectable()
export class MediaService {
  private readonly urlKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly idempotency: IdempotencyService,
    private readonly policy: PolicyService,
    private readonly postVisibility: PostVisibilityService,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    // Derived key, never the raw JWT secret.
    this.urlKey = Buffer.from(
      hkdfSync(
        'sha256',
        config.get('JWT_ACCESS_SECRET', { infer: true }),
        Buffer.alloc(0),
        HKDF_INFO,
        32,
      ),
    );
  }

  /** For other modules: every id must be a READY asset of `userId`. */
  assertOwnedReady(db: Db, userId: string, mediaIds: readonly string[]): Promise<MediaAsset[]> {
    return assertOwnedReady(db, userId, mediaIds);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  createIntent(
    userId: string,
    dto: CreateUploadDto,
    key: string | undefined,
  ): Promise<MediaAssetDto> {
    const limits = MEDIA_LIMITS[dto.kind];
    if (!limits.mimeTypes.includes(dto.mimeType)) {
      throw new ApiError(ErrorCode.UPLOAD_FAILED, 'This file type is not allowed', {
        field: 'mimeType',
        kind: dto.kind,
        allowed: limits.mimeTypes,
      });
    }
    if (dto.sizeBytes > limits.maxBytes) {
      throw new ApiError(ErrorCode.UPLOAD_FAILED, 'This file is too large', {
        field: 'sizeBytes',
        kind: dto.kind,
        maxBytes: limits.maxBytes,
      });
    }
    if (dto.durationSeconds !== undefined) {
      if (limits.maxDurationSeconds === null) {
        throw new ApiError(ErrorCode.VALIDATION, 'durationSeconds only applies to videos', {
          field: 'durationSeconds',
        });
      }
      if (dto.durationSeconds > limits.maxDurationSeconds) {
        throw new ApiError(ErrorCode.UPLOAD_FAILED, 'This video is too long', {
          field: 'durationSeconds',
          maxDurationSeconds: limits.maxDurationSeconds,
        });
      }
    }
    return this.idempotency.execute(
      { userId, scope: 'media.intent', key, payload: dto },
      async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            ownerId: userId,
            kind: dto.kind,
            status: 'UPLOADING',
            visibility: dto.visibility ?? 'PRIVATE',
            mimeType: dto.mimeType,
            sizeBytes: BigInt(dto.sizeBytes),
            storageKey: `${userId}/${randomUUID()}`,
            durationSeconds: dto.durationSeconds ?? null,
          },
        });
        return {
          ...this.toDto({ ...asset, variants: [] }),
          upload: {
            method: 'PUT',
            path: `/v1/media/${asset.id}/content`,
            contentType: asset.mimeType,
            maxBytes: dto.sizeBytes,
          },
        };
      },
    );
  }

  /** Stores the bytes. Any violation marks the asset FAILED (retry = new intent). */
  async upload(
    userId: string,
    id: string,
    body: Readable,
    contentType: string | undefined,
    contentLength: number | undefined,
  ): Promise<MediaAssetDto> {
    const asset = await this.ownedOrThrow(userId, id);
    if (asset.status !== 'UPLOADING') {
      throw new ApiError(ErrorCode.CONFLICT, 'This upload is no longer accepting content', {
        status: asset.status,
      });
    }
    const declared = Number(asset.sizeBytes);
    const type = contentType?.split(';')[0]?.trim().toLowerCase();
    if (type && type !== asset.mimeType && type !== 'application/octet-stream') {
      throw await this.fail(asset, 'MIME_MISMATCH');
    }
    if (contentLength !== undefined && contentLength > declared) {
      throw await this.fail(asset, 'SIZE_EXCEEDS_DECLARED');
    }
    let stored;
    try {
      stored = await this.storage.write(asset.storageKey, body, declared);
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw await this.fail(asset, 'SIZE_EXCEEDS_DECLARED');
      throw await this.fail(asset, 'UPLOAD_INTERRUPTED');
    }
    if (stored.sizeBytes === 0) throw await this.fail(asset, 'EMPTY_FILE');
    if (!sniffMatches(asset.mimeType, stored.head))
      throw await this.fail(asset, 'CONTENT_TYPE_MISMATCH');

    const claimed = await this.prisma.mediaAsset.updateMany({
      where: { id, status: 'UPLOADING' },
      data: { status: 'PROCESSING', sizeBytes: BigInt(stored.sizeBytes), checksum: stored.sha256 },
    });
    if (claimed.count !== 1) {
      throw new ApiError(ErrorCode.CONFLICT, 'This upload is no longer accepting content');
    }
    return this.toDto(await this.reload(id));
  }

  /**
   * PROCESSING -> READY. Idempotent for an already READY asset. Photos go through the image
   * pipeline (decode with pixel limit, auto-orient, re-encode without any metadata, variants);
   * videos and documents are stored unchanged.
   */
  async finalize(userId: string, id: string, checksum: string | undefined): Promise<MediaAssetDto> {
    const asset = await this.ownedOrThrow(userId, id);
    if (asset.status === 'READY') return this.toDto(asset);
    if (asset.status === 'FAILED') {
      throw new ApiError(ErrorCode.UPLOAD_FAILED, 'This upload failed. Start a new upload.', {
        reason: asset.failureReason,
      });
    }
    if (asset.status !== 'PROCESSING') {
      throw new ApiError(ErrorCode.CONFLICT, 'Upload the content before finishing', {
        status: asset.status,
      });
    }
    if (checksum && asset.checksum && checksum.toLowerCase() !== asset.checksum) {
      throw await this.fail(asset, 'CHECKSUM_MISMATCH');
    }
    if (!(await this.storage.exists(asset.storageKey)))
      throw await this.fail(asset, 'CONTENT_MISSING');

    if (asset.kind === 'PHOTO') {
      // serialise concurrent finalize calls of the same asset (DB advisory lock, restart-safe)
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:${id}`}, 0))`;
          const cur = await tx.mediaAsset.findUnique({ where: { id }, select: { status: true } });
          if (cur?.status === 'PROCESSING') await this.processPhoto(asset);
        },
        { timeout: 60_000, maxWait: 30_000 },
      );
    } else {
      await this.prisma.mediaAsset.updateMany({
        where: { id, status: 'PROCESSING' },
        data: { status: 'READY', readyAt: this.clock.now() },
      });
    }
    return this.toDto(await this.reload(id));
  }

  private async readAll(key: string): Promise<Buffer> {
    const { stream } = await this.storage.read(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(chunks);
  }

  /**
   * Real pixel pipeline. The re-encoded, oriented, metadata-free image REPLACES the upload as
   * the canonical original; thumb and card WebP variants are stored under their own keys.
   */
  private async processPhoto(asset: MediaAsset): Promise<void> {
    const written: string[] = [];
    try {
      let raw: Buffer;
      try {
        raw = await this.readAll(asset.storageKey);
      } catch {
        throw await this.fail(asset, 'CONTENT_MISSING');
      }
      const input = () => sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
      let meta;
      try {
        meta = await input().metadata();
      } catch {
        throw await this.fail(asset, 'IMAGE_UNDECODABLE');
      }
      const format = SHARP_FORMATS[asset.mimeType];
      if (!format || meta.format !== format) throw await this.fail(asset, 'CONTENT_TYPE_MISMATCH');
      if ((meta.pages ?? 1) > 1) throw await this.fail(asset, 'ANIMATED_IMAGE_NOT_SUPPORTED');
      if (!meta.width || !meta.height) throw await this.fail(asset, 'IMAGE_UNDECODABLE');
      if (meta.width * meta.height > MAX_INPUT_PIXELS) {
        throw await this.fail(asset, 'IMAGE_TOO_MANY_PIXELS');
      }

      let original: { data: Buffer; info: OutputInfo };
      const variants: { label: string; data: Buffer; info: OutputInfo; key: string }[] = [];
      try {
        // rotate() applies the EXIF orientation; sharp writes no metadata unless asked to.
        const base = input().rotate();
        original =
          format === 'jpeg'
            ? await base.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true })
            : format === 'png'
              ? await base.png().toBuffer({ resolveWithObject: true })
              : await base.webp({ quality: 92 }).toBuffer({ resolveWithObject: true });
        for (const spec of VARIANT_SPECS) {
          const out = await sharp(original.data, { limitInputPixels: MAX_INPUT_PIXELS })
            .resize({ width: spec.max, height: spec.max, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer({ resolveWithObject: true });
          variants.push({ label: spec.label, ...out, key: `${asset.ownerId}/${randomUUID()}` });
        }
      } catch {
        throw await this.fail(asset, 'IMAGE_UNDECODABLE');
      }

      const stored = await this.storage.write(
        asset.storageKey,
        Readable.from(original.data),
        original.data.length + 1,
      );
      for (const v of variants) {
        await this.storage.write(v.key, Readable.from(v.data), v.data.length + 1);
        written.push(v.key);
      }
      const won = await this.prisma.$transaction(async (tx) => {
        const upd = await tx.mediaAsset.updateMany({
          where: { id: asset.id, status: 'PROCESSING' },
          data: {
            status: 'READY',
            readyAt: this.clock.now(),
            sizeBytes: BigInt(stored.sizeBytes),
            checksum: stored.sha256,
            width: original.info.width,
            height: original.info.height,
            metadataStripped: true,
          },
        });
        if (upd.count !== 1) return false;
        await tx.mediaVariant.createMany({
          data: variants.map((v) => ({
            assetId: asset.id,
            label: v.label,
            storageKey: v.key,
            mimeType: 'image/webp',
            width: v.info.width,
            height: v.info.height,
            sizeBytes: v.info.size,
          })),
          skipDuplicates: true,
        });
        return true;
      });
      if (!won) await Promise.all(written.map((k) => this.storage.delete(k)));
    } catch (err) {
      await Promise.all(written.map((k) => this.storage.delete(k)));
      throw err;
    }
  }

  private async reload(id: string): Promise<AssetWithVariants> {
    return this.prisma.mediaAsset.findUniqueOrThrow({ where: { id }, include: WITH_VARIANTS });
  }

  async getOwn(userId: string, id: string): Promise<MediaAssetDto> {
    return this.toDto(await this.ownedOrThrow(userId, id));
  }

  async listOwn(userId: string, q: PageQuery): Promise<MediaPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.prisma.mediaAsset.findMany({
      where: {
        ownerId: userId,
        NOT: { failureReason: MEDIA_DELETED_REASON },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: WITH_VARIANTS,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  /** Soft delete of own, unattached media (the schema has no deletedAt: FAILED + marker). */
  async remove(userId: string, id: string): Promise<void> {
    const asset = await this.ownedOrThrow(userId, id, true);
    if (asset.failureReason === MEDIA_DELETED_REASON) return;
    if (await this.isAttached(id)) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'This media is attached to content. Remove it there first.',
      );
    }
    await this.prisma.mediaAsset.update({
      where: { id },
      data: { status: 'FAILED', failureReason: MEDIA_DELETED_REASON },
    });
    await this.storage.delete(asset.storageKey);
    await this.dropVariants(id);
  }

  private async dropVariants(assetId: string): Promise<void> {
    const rows = await this.prisma.mediaVariant.findMany({ where: { assetId } });
    await Promise.all(rows.map((v) => this.storage.delete(v.storageKey)));
    await this.prisma.mediaVariant.deleteMany({ where: { assetId } });
  }

  // ───────────────────────── access ─────────────────────────

  /** Re-checks access on EVERY call and returns a short-lived signed URL. */
  async signedUrl(
    viewerId: string | null,
    id: string,
    variant: MediaVariantLabel = 'original',
  ): Promise<SignedUrlDto> {
    if (!MEDIA_VARIANTS.includes(variant)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown variant', { field: 'variant' });
    }
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.status !== 'READY' || !(await this.canAccess(viewerId, asset))) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    if (variant !== 'original') {
      const v = await this.prisma.mediaVariant.findUnique({
        where: { assetId_label: { assetId: id, label: variant } },
        select: { id: true },
      });
      if (!v) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const exp = Math.floor(this.clock.now().getTime() / 1000) + SIGNED_URL_TTL_SECONDS;
    return {
      url: `/v1/media/${id}/content?token=${this.sign(id, exp, variant)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Token-authorised streaming of the bytes. */
  async openContent(id: string, token: string) {
    const variant = this.verify(id, token);
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.status !== 'READY') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    let key = asset.storageKey;
    let mimeType = asset.mimeType;
    if (variant !== 'original') {
      const v = await this.prisma.mediaVariant.findUnique({
        where: { assetId_label: { assetId: id, label: variant } },
      });
      if (!v) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      key = v.storageKey;
      mimeType = v.mimeType;
    }
    let object;
    try {
      object = await this.storage.read(key);
    } catch {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return { ...object, mimeType, kind: asset.kind as MediaKind };
  }

  private sign(id: string, expSeconds: number, variant: MediaVariantLabel): string {
    const payload = Buffer.from(JSON.stringify([id, expSeconds, variant]), 'utf8').toString(
      'base64url',
    );
    const mac = createHmac('sha256', this.urlKey).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  private verify(id: string, token: string): MediaVariantLabel {
    const [payload, mac] = token.split('.');
    if (!payload || !mac)
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    const expected = createHmac('sha256', this.urlKey).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    if (!Array.isArray(parsed) || parsed[0] !== id || typeof parsed[1] !== 'number') {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    const variant = parsed[2];
    if (typeof variant !== 'string' || !(MEDIA_VARIANTS as readonly string[]).includes(variant)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    if (parsed[1] * 1000 <= this.clock.now().getTime()) {
      throw new ApiError(ErrorCode.EXPIRED, 'This link has expired.');
    }
    return variant as MediaVariantLabel;
  }

  /**
   * Owner; PUBLIC media; or media attached to something the viewer may see (post, avatar,
   * club/tournament logo, sponsor, tournament document).
   */
  async canAccess(viewerId: string | null, asset: MediaAsset): Promise<boolean> {
    if (viewerId && asset.ownerId === viewerId) return true;
    if (asset.visibility === 'PUBLIC') return true;
    const id = asset.id;

    const postLinks = await this.prisma.postMedia.findMany({
      where: { mediaId: id, post: { status: 'PUBLISHED' } },
      select: {
        post: {
          select: {
            id: true,
            authorId: true,
            authorType: true,
            authorEntityId: true,
            audience: true,
            status: true,
          },
        },
      },
      take: 50,
    });
    if (postLinks.length > 0) {
      const ok = await this.postVisibility.filterViewable(
        this.prisma,
        viewerId,
        postLinks.map((l) => l.post),
      );
      if (ok.size > 0) return true;
    }

    const avatar = await this.prisma.profile.findFirst({
      where: { avatarId: id, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    if (avatar && !(viewerId && (await this.isBlocked(viewerId, avatar.userId)))) return true;

    const clubs = await this.prisma.club.findMany({
      where: { OR: [{ logoMediaId: id }, { coverMediaId: id }], status: 'ACTIVE' },
      select: { id: true, visibility: true, ownerId: true },
    });
    for (const c of clubs) {
      if (c.visibility === 'PUBLIC') return true;
      if (viewerId && (c.ownerId === viewerId || (await this.isMember(viewerId, c.id))))
        return true;
    }

    const tournamentIds = new Set<string>();
    for (const t of await this.prisma.tournament.findMany({
      where: { logoMediaId: id },
      select: { id: true },
    })) {
      tournamentIds.add(t.id);
    }
    for (const s of await this.prisma.sponsor.findMany({
      where: {
        hiddenAt: null,
        OR: [{ logoMediaId: id }, { assets: { some: { mediaId: id, hiddenAt: null } } }],
      },
      select: { tournamentId: true },
    })) {
      tournamentIds.add(s.tournamentId);
    }
    for (const d of await this.prisma.documentVersion.findMany({
      where: { fileMediaId: id },
      select: { document: { select: { tournamentId: true } } },
    })) {
      tournamentIds.add(d.document.tournamentId);
    }
    for (const tid of tournamentIds) {
      if (await this.canSeeTournament(viewerId, tid)) return true;
    }
    return false;
  }

  private async canSeeTournament(viewerId: string | null, tournamentId: string): Promise<boolean> {
    const t = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { isPublic: true, status: true },
    });
    if (!t) return false;
    if (tournamentIsPublic(t)) return true;
    return viewerId
      ? this.policy.can(viewerId, Permission.TOURNAMENT_MANAGE, {
          type: 'TOURNAMENT',
          id: tournamentId,
        })
      : false;
  }

  private async isMember(userId: string, clubId: string): Promise<boolean> {
    const m = await this.prisma.membership.findFirst({
      where: { userId, clubId, status: 'MEMBER' },
      select: { id: true },
    });
    return m !== null;
  }

  private async isBlocked(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const row = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { blockerId: true },
    });
    return row !== null;
  }

  private async isAttached(id: string): Promise<boolean> {
    const [post, avatar, club, tournament, sponsor, sponsorAsset, doc] = await Promise.all([
      this.prisma.postMedia.count({ where: { mediaId: id, post: { status: { not: 'DELETED' } } } }),
      this.prisma.profile.count({ where: { avatarId: id } }),
      this.prisma.club.count({ where: { OR: [{ logoMediaId: id }, { coverMediaId: id }] } }),
      this.prisma.tournament.count({ where: { logoMediaId: id } }),
      this.prisma.sponsor.count({ where: { logoMediaId: id } }),
      this.prisma.sponsorAsset.count({ where: { mediaId: id } }),
      this.prisma.documentVersion.count({ where: { fileMediaId: id } }),
    ]);
    return post + avatar + club + tournament + sponsor + sponsorAsset + doc > 0;
  }

  // ───────────────────────── helpers ─────────────────────────

  private async ownedOrThrow(
    userId: string,
    id: string,
    allowDeleted = false,
  ): Promise<AssetWithVariants> {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id },
      include: WITH_VARIANTS,
    });
    if (
      !asset ||
      asset.ownerId !== userId ||
      (!allowDeleted && asset.failureReason === MEDIA_DELETED_REASON)
    ) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return asset;
  }

  /** Marks FAILED, drops stored bytes and returns the UPLOAD_FAILED error to throw. */
  private async fail(asset: MediaAsset, reason: string): Promise<ApiError> {
    await this.prisma.mediaAsset.updateMany({
      where: { id: asset.id, status: { in: ['UPLOADING', 'PROCESSING'] } },
      data: { status: 'FAILED', failureReason: reason },
    });
    await this.storage.delete(asset.storageKey);
    await this.dropVariants(asset.id);
    return new ApiError(ErrorCode.UPLOAD_FAILED, 'The upload failed. Please start a new upload.', {
      reason,
      declaredSizeBytes: Number(asset.sizeBytes),
    });
  }

  private toDto(a: AssetWithVariants): MediaAssetDto {
    return {
      id: a.id,
      kind: a.kind,
      status: a.status,
      visibility: a.visibility,
      mimeType: a.mimeType,
      sizeBytes: Number(a.sizeBytes),
      durationSeconds: a.durationSeconds,
      checksum: a.checksum,
      failureReason: a.failureReason === MEDIA_DELETED_REASON ? null : a.failureReason,
      createdAt: a.createdAt.toISOString(),
      readyAt: a.readyAt ? a.readyAt.toISOString() : null,
      width: a.width,
      height: a.height,
      metadataStripped: a.metadataStripped,
      variants: [...a.variants]
        .sort((x, y) => x.width - y.width || y.label.localeCompare(x.label))
        .map((v) => ({ label: v.label, width: v.width, height: v.height })),
    };
  }
}
