import { Injectable } from '@nestjs/common';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  ENTITY_TYPES,
  RecentSearchDto,
  RecentSearchListDto,
  RecordRecentDto,
  SearchEntityType,
  SearchType,
} from './dto';
import { SearchService } from './search.service';

export const RECENT_SEARCH_LIMIT = 20;
const QUERY_MIN = 2;
const QUERY_MAX = 80;

const TYPE_OF: Record<SearchEntityType, SearchType> = {
  PERSON: 'people',
  CLUB: 'clubs',
  VENUE: 'venues',
  PITCH: 'pitches',
  TOURNAMENT: 'tournaments',
  EVENT: 'events',
};

interface RecentRow {
  id: string;
  query: string | null;
  entityType: string | null;
  entityId: string | null;
  lastUsedAt: Date;
}

/**
 * Per-user search history. Never an authorization source: entity entries are re-resolved
 * through the search visibility rules on every read, and anything no longer visible comes
 * back as a neutral `{unavailable:true}` with no name, handle or city.
 */
@Injectable()
export class RecentSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly clock: Clock,
  ) {}

  async record(userId: string, dto: RecordRecentDto): Promise<RecentSearchDto> {
    const hasQuery = dto.query !== undefined;
    const hasEntity = dto.entityType !== undefined || dto.entityId !== undefined;
    if (hasQuery === hasEntity) {
      throw new ApiError(ErrorCode.VALIDATION, 'Send either `query` or `entityType` + `entityId`', {
        field: 'query',
      });
    }
    let dedupeKey: string;
    let query: string | null = null;
    let entityType: SearchEntityType | null = null;
    let entityId: string | null = null;
    if (hasQuery) {
      const trimmed = (dto.query as string).trim();
      if (trimmed.length < QUERY_MIN || trimmed.length > QUERY_MAX) {
        throw new ApiError(
          ErrorCode.VALIDATION,
          `Query must be ${QUERY_MIN}-${QUERY_MAX} characters`,
          { field: 'query', min: QUERY_MIN, max: QUERY_MAX },
        );
      }
      query = trimmed;
      dedupeKey = `q:${trimmed.toLowerCase()}`;
    } else {
      if (!dto.entityType || !dto.entityId) {
        throw new ApiError(ErrorCode.VALIDATION, '`entityType` and `entityId` go together', {
          field: 'entityId',
        });
      }
      entityType = dto.entityType;
      entityId = dto.entityId.toLowerCase();
      dedupeKey = `e:${entityType}:${entityId}`;
      // only things the user can actually see are worth remembering
      const visible = await this.search.lookup(userId, TYPE_OF[entityType], [entityId]);
      if (!visible.has(entityId)) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      }
    }

    const now = this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      // serialise a user's history writes (cap + upsert) without blocking anyone else
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`recent:${userId}`}, 0))`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "RecentSearch" (id, "userId", "dedupeKey", query, "entityType", "entityId", "createdAt", "lastUsedAt")
        VALUES (gen_random_uuid(), ${userId}::uuid, ${dedupeKey}, ${query}, ${entityType}, ${entityId}::uuid, ${now}, ${now})
        ON CONFLICT ("userId", "dedupeKey")
        DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt", query = EXCLUDED.query
        RETURNING id::text AS id`;
      await tx.$executeRaw`
        DELETE FROM "RecentSearch"
        WHERE "userId" = ${userId}::uuid AND id IN (
          SELECT id FROM "RecentSearch" WHERE "userId" = ${userId}::uuid
          ORDER BY "lastUsedAt" DESC, id DESC OFFSET ${RECENT_SEARCH_LIMIT})`;
      return rows[0]?.id as string;
    });
    const row = await this.prisma.recentSearch.findUnique({ where: { id } });
    if (!row) throw new ApiError(ErrorCode.CONFLICT, 'Recent search was removed');
    return (await this.present(userId, [row]))[0] as RecentSearchDto;
  }

  async list(userId: string): Promise<RecentSearchListDto> {
    const rows = await this.prisma.recentSearch.findMany({
      where: { userId },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_SEARCH_LIMIT,
    });
    return { items: await this.present(userId, rows) };
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.recentSearch.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
  }

  async clear(userId: string): Promise<void> {
    await this.prisma.recentSearch.deleteMany({ where: { userId } });
  }

  private async present(userId: string, rows: RecentRow[]): Promise<RecentSearchDto[]> {
    const byType = new Map<SearchEntityType, string[]>();
    for (const r of rows) {
      if (
        r.entityType &&
        r.entityId &&
        (ENTITY_TYPES as readonly string[]).includes(r.entityType)
      ) {
        const t = r.entityType as SearchEntityType;
        byType.set(t, [...(byType.get(t) ?? []), r.entityId]);
      }
    }
    const resolved = new Map<string, Awaited<ReturnType<SearchService['lookup']>>>();
    for (const [t, ids] of byType) {
      resolved.set(t, await this.search.lookup(userId, TYPE_OF[t], ids));
    }
    return rows.map((r) => {
      if (r.query !== null) {
        return {
          id: r.id,
          kind: 'QUERY' as const,
          query: r.query,
          entityType: null,
          entityId: null,
          unavailable: false,
          entity: null,
          lastUsedAt: r.lastUsedAt.toISOString(),
        };
      }
      const hit =
        r.entityType && r.entityId ? resolved.get(r.entityType)?.get(r.entityId) : undefined;
      return {
        id: r.id,
        kind: 'ENTITY' as const,
        query: null,
        entityType: (r.entityType as SearchEntityType | null) ?? null,
        entityId: r.entityId,
        unavailable: !hit,
        entity: hit ? { name: hit.name, handle: hit.handle, subtitle: hit.subtitle } : null,
        lastUsedAt: r.lastUsedAt.toISOString(),
      };
    });
  }
}
