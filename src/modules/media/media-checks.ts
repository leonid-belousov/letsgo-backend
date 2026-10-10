import type { MediaAsset, MediaKind } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import type { Db } from '../../common/transactions/tx';

/** Marker stored in `failureReason` when the owner deleted the asset (schema has no deletedAt). */
export const MEDIA_DELETED_REASON = 'DELETED_BY_OWNER';

/**
 * Every id must be a READY asset owned by `userId`. Returns the assets in the order of `mediaIds`.
 * FAILED / UPLOADING / PROCESSING / deleted assets are never attachable.
 * Pure function so any module can call it inside its own transaction.
 */
export async function assertOwnedReady(
  db: Db,
  userId: string,
  mediaIds: readonly string[],
  opts: { kinds?: readonly MediaKind[] } = {},
): Promise<MediaAsset[]> {
  const unique = [...new Set(mediaIds)];
  if (unique.length !== mediaIds.length) {
    throw new ApiError(ErrorCode.VALIDATION, 'Duplicate media ids', { field: 'mediaIds' });
  }
  if (unique.length === 0) return [];
  const rows = await db.mediaAsset.findMany({ where: { id: { in: unique } } });
  const by = new Map(rows.map((r) => [r.id, r]));
  const invalid: { id: string; reason: string }[] = [];
  const ordered: MediaAsset[] = [];
  for (const id of unique) {
    const a = by.get(id);
    if (!a || a.ownerId !== userId) invalid.push({ id, reason: 'NOT_FOUND' });
    else if (a.status !== 'READY') invalid.push({ id, reason: `NOT_READY:${a.status}` });
    else if (opts.kinds && !opts.kinds.includes(a.kind)) invalid.push({ id, reason: 'KIND' });
    else ordered.push(a);
  }
  if (invalid.length > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION,
      'Some media cannot be attached: it must be uploaded, finished and yours.',
      { field: 'mediaIds', invalid },
    );
  }
  return ordered;
}
