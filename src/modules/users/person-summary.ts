import { ApiProperty } from '@nestjs/swagger';
import type { Db } from '../../common/transactions/tx';

/** The always-public identity of a person: safe to embed in any DTO. */
export class PersonSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarId!: string | null;
}

export async function loadPersonSummaries(
  db: Db,
  ids: string[],
): Promise<Map<string, PersonSummaryDto>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.profile.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, nickname: true, username: true, avatarId: true },
  });
  return new Map(
    rows.map((r) => [
      r.userId,
      { id: r.userId, nickname: r.nickname, username: r.username, avatarId: r.avatarId },
    ]),
  );
}

export function personOrUnknown(map: Map<string, PersonSummaryDto>, id: string): PersonSummaryDto {
  return map.get(id) ?? { id, nickname: null, username: null, avatarId: null };
}
