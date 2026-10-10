import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { clampPageSize, decodeCursor, encodeCursor } from '../../common/pagination/cursor-page';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  SearchEntityType,
  SearchQuery,
  SearchResponseDto,
  SearchResultDto,
  SearchSectionDto,
  SearchType,
  SEARCH_TYPES,
} from './dto';

const OVERVIEW_PER_TYPE = 4;
const ENTITY_OF: Record<SearchType, SearchEntityType> = {
  people: 'PERSON',
  clubs: 'CLUB',
  venues: 'VENUE',
  pitches: 'PITCH',
  tournaments: 'TOURNAMENT',
  events: 'EVENT',
};

interface Row {
  id: string;
  name: string | null;
  handle: string | null;
  city: string | null;
  rank: number;
  sim: number;
}

interface Source {
  /** FROM ... WHERE <visibility> — everything already restricted to what the viewer may see */
  from: Prisma.Sql;
  id: Prisma.Sql;
  name: Prisma.Sql;
  handle: Prisma.Sql;
  city: Prisma.Sql;
}

interface Needle {
  exact: string;
  prefix: string;
  contains: string;
  handleOnly: boolean;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search (Handoff §7). Ranking: exact @username, then case-insensitive prefix of
 * nickname/handle, then trigram/substring similarity; ties by similarity then id (stable
 * keyset). All values are bound parameters; identifiers are fixed constants.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(viewerId: string | null, query: SearchQuery): Promise<SearchResponseDto> {
    const trimmed = query.q.trim();
    const handleOnly = trimmed.startsWith('@');
    const term = (handleOnly ? trimmed.slice(1) : trimmed).trim().toLowerCase();
    if (!term) {
      throw new ApiError(ErrorCode.VALIDATION, 'Search text is empty', { field: 'q' });
    }
    const needle: Needle = {
      exact: term,
      prefix: `${escapeLike(term)}%`,
      contains: `%${escapeLike(term)}%`,
      handleOnly,
    };

    if (!query.type) {
      // handle search only makes sense for entities with handles
      const types = handleOnly ? (['people', 'clubs'] as const) : SEARCH_TYPES;
      const sections: SearchSectionDto[] = [];
      for (const type of types) {
        const source = this.source(type, viewerId);
        const [rows, total] = await Promise.all([
          this.run(source, needle, OVERVIEW_PER_TYPE, undefined),
          this.count(source, needle),
        ]);
        sections.push({
          type,
          entityType: ENTITY_OF[type],
          items: rows.map((r) => this.toResult(type, r)),
          total,
        });
      }
      return { q: trimmed, type: null, sections, items: null, nextCursor: null, total: null };
    }

    if (handleOnly && query.type !== 'people' && query.type !== 'clubs') {
      return {
        q: trimmed,
        type: query.type,
        sections: null,
        items: [],
        nextCursor: null,
        total: 0,
      };
    }
    const limit = clampPageSize(query.limit);
    const cursor = decodeCursor(query.cursor);
    let after: { rank: number; sim: number; id: string } | undefined;
    if (cursor) {
      const [rank, sim] = cursor.t.split(':').map(Number);
      if (rank === undefined || sim === undefined || Number.isNaN(rank) || Number.isNaN(sim)) {
        throw new ApiError(ErrorCode.VALIDATION, 'Invalid cursor', { field: 'cursor' });
      }
      after = { rank, sim, id: cursor.id };
    }
    const source = this.source(query.type, viewerId);
    const [rows, total] = await Promise.all([
      this.run(source, needle, limit + 1, after),
      this.count(source, needle),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      q: trimmed,
      type: query.type,
      sections: null,
      items: page.map((r) => this.toResult(query.type as SearchType, r)),
      nextCursor:
        hasMore && last ? encodeCursor({ t: `${last.rank}:${last.sim}`, id: last.id }) : null,
      total,
    };
  }

  private toResult(type: SearchType, r: Row): SearchResultDto {
    return {
      entityType: ENTITY_OF[type],
      id: r.id,
      name: r.name,
      handle: r.handle,
      subtitle: r.city,
    };
  }

  private inner(source: Source, n: Needle): Prisma.Sql {
    const nameLow = n.handleOnly
      ? Prisma.sql`lower(${source.handle})`
      : Prisma.sql`lower(${source.name})`;
    const handle = Prisma.sql`${source.handle}`;
    return Prisma.sql`
      SELECT ${source.id} AS id, ${source.name} AS name, ${source.handle} AS handle, ${source.city} AS city,
        (CASE
          WHEN ${handle} = ${n.exact} THEN 0
          WHEN ${nameLow} LIKE ${n.prefix} ESCAPE '\\' OR ${handle} LIKE ${n.prefix} ESCAPE '\\' THEN 1
          ELSE 2
        END)::int AS rank,
        floor(GREATEST(similarity(${nameLow}, ${n.exact}), similarity(coalesce(${handle}, ''), ${n.exact})) * 1000)::int AS sim
      ${source.from}
        AND (
          ${handle} = ${n.exact}
          OR ${nameLow} LIKE ${n.prefix} ESCAPE '\\'
          OR ${handle} LIKE ${n.prefix} ESCAPE '\\'
          OR ${nameLow} LIKE ${n.contains} ESCAPE '\\'
          OR ${nameLow} % ${n.exact}
        )`;
  }

  private async run(
    source: Source,
    n: Needle,
    take: number,
    after: { rank: number; sim: number; id: string } | undefined,
  ): Promise<Row[]> {
    const cond = after
      ? Prisma.sql`WHERE (r.rank, -r.sim, r.id) > (${after.rank}::int, ${-after.sim}::int, ${after.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT r.id::text AS id, r.name, r.handle, r.city, r.rank, r.sim
      FROM (${this.inner(source, n)}) r
      ${cond}
      ORDER BY r.rank ASC, r.sim DESC, r.id ASC
      LIMIT ${take}`);
  }

  /**
   * Re-resolves known ids through exactly the visibility rules search itself applies
   * (used by recent searches so hidden/blocked/deleted entities never leak).
   */
  async lookup(
    viewerId: string | null,
    type: SearchType,
    ids: string[],
  ): Promise<Map<string, SearchResultDto>> {
    const out = new Map<string, SearchResultDto>();
    if (ids.length === 0) return out;
    const source = this.source(type, viewerId);
    const rows = await this.prisma.$queryRaw<Omit<Row, 'rank' | 'sim'>[]>(Prisma.sql`
      SELECT ${source.id}::text AS id, ${source.name} AS name, ${source.handle} AS handle, ${source.city} AS city
      ${source.from}
        AND ${source.id} = ANY(${ids}::uuid[])`);
    for (const r of rows) out.set(r.id, this.toResult(type, { ...r, rank: 0, sim: 0 }));
    return out;
  }

  private async count(source: Source, n: Needle): Promise<number> {
    const res = await this.prisma.$queryRaw<{ total: bigint }[]>(
      Prisma.sql`SELECT count(*) AS total FROM (${this.inner(source, n)}) r`,
    );
    return Number(res[0]?.total ?? 0);
  }

  private blockClause(viewerId: string | null, col: string): Prisma.Sql {
    if (!viewerId) return Prisma.empty;
    const c = Prisma.raw(col);
    return Prisma.sql`AND NOT EXISTS (
      SELECT 1 FROM "Block" b
      WHERE (b."blockerId" = ${viewerId}::uuid AND b."blockedId" = ${c})
         OR (b."blockedId" = ${viewerId}::uuid AND b."blockerId" = ${c}))`;
  }

  private source(type: SearchType, viewerId: string | null): Source {
    switch (type) {
      case 'people':
        return {
          // Private profiles are findable by identity only; DELETED/SUSPENDED users never
          from: Prisma.sql`FROM "Profile" p JOIN "User" u ON u.id = p."userId"
            WHERE u.status = 'ACTIVE' AND p.username IS NOT NULL ${this.blockClause(viewerId, 'p."userId"')}`,
          id: Prisma.sql`p."userId"`,
          name: Prisma.sql`p.nickname`,
          handle: Prisma.sql`p.username`,
          city: Prisma.sql`NULL::text`,
        };
      case 'clubs':
        return {
          from: Prisma.sql`FROM "Club" c WHERE c.status = 'ACTIVE'`,
          id: Prisma.sql`c.id`,
          name: Prisma.sql`c.name`,
          handle: Prisma.sql`c.username`,
          city: Prisma.sql`c.city`,
        };
      case 'venues':
        return {
          from: Prisma.sql`FROM "Venue" v WHERE v.status = 'PUBLISHED'`,
          id: Prisma.sql`v.id`,
          name: Prisma.sql`v.name`,
          handle: Prisma.sql`NULL::text`,
          city: Prisma.sql`v.city`,
        };
      case 'pitches':
        return {
          from: Prisma.sql`FROM "Pitch" pi JOIN "Venue" v ON v.id = pi."venueId"
            WHERE pi.status = 'PUBLISHED' AND v.status = 'PUBLISHED'`,
          id: Prisma.sql`pi.id`,
          name: Prisma.sql`pi.name`,
          handle: Prisma.sql`NULL::text`,
          city: Prisma.sql`v.city`,
        };
      case 'tournaments':
        return {
          from: Prisma.sql`FROM "Tournament" t WHERE t."isPublic" AND t.status <> 'DRAFT'`,
          id: Prisma.sql`t.id`,
          name: Prisma.sql`t.name`,
          handle: Prisma.sql`NULL::text`,
          city: Prisma.sql`t.city`,
        };
      case 'events': {
        const member = viewerId
          ? Prisma.sql`OR c."ownerId" = ${viewerId}::uuid OR e."organiserId" = ${viewerId}::uuid
              OR EXISTS (SELECT 1 FROM "Membership" m WHERE m."clubId" = e."clubId"
                         AND m."userId" = ${viewerId}::uuid AND m.status = 'MEMBER')`
          : Prisma.empty;
        return {
          from: Prisma.sql`FROM "Event" e
            LEFT JOIN "Club" c ON c.id = e."clubId"
            LEFT JOIN "Venue" v ON v.id = e."venueId"
            WHERE e.status <> 'DRAFT' AND e.title IS NOT NULL
              AND (e."clubId" IS NULL OR c.visibility = 'PUBLIC' ${member})
              ${this.blockClause(viewerId, 'e."organiserId"')}`,
          id: Prisma.sql`e.id`,
          name: Prisma.sql`e.title`,
          handle: Prisma.sql`NULL::text`,
          city: Prisma.sql`v.city`,
        };
      }
    }
  }
}
