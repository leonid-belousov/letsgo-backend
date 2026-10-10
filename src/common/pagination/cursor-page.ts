import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiError, ErrorCode } from '../errors';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Query params shared by every keyset-paginated list. */
export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class PageMeta {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Pass as `cursor` to get the next page',
  })
  nextCursor!: string | null;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function clampPageSize(requested: number | undefined): number {
  if (!requested || requested < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

export interface CursorKey {
  /** ISO time or other sortable string primary key of the cursor */
  t: string;
  id: string;
}

/** Cursors are opaque to clients: base64url(JSON). */
export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorKey | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as CursorKey).t === 'string' &&
      typeof (parsed as CursorKey).id === 'string'
    ) {
      return { t: (parsed as CursorKey).t, id: (parsed as CursorKey).id };
    }
  } catch {
    // fall through
  }
  throw new ApiError(ErrorCode.VALIDATION, 'Invalid cursor', { field: 'cursor' });
}

/**
 * Turns `limit + 1` fetched rows into a page. `keyOf` produces the cursor key of the
 * last *returned* row, so ordering must be the same (t, id) pair used in the query.
 */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null };
}

/**
 * Prisma `where` fragment for "rows strictly after `cursor`" in (timeField DESC, id DESC) order.
 * Use with `orderBy: [{ [timeField]: 'desc' }, { id: 'desc' }]` and `take: limit + 1`.
 */
export function keysetBefore<F extends string>(
  timeField: F,
  cursor: CursorKey | undefined,
): Record<string, unknown> {
  if (!cursor) return {};
  const t = new Date(cursor.t);
  return {
    OR: [{ [timeField]: { lt: t } }, { [timeField]: t, id: { lt: cursor.id } }],
  };
}
