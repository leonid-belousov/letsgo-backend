import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import type { ActivityItem } from '@prisma/client';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  PageQuery,
  toPage,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { loadPersonSummaries, personOrUnknown, PersonSummaryDto } from '../users/person-summary';

export class ActivityQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Only unread items' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
}

export class MarkReadDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class ActivityItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'invitation.received' }) kind!: string;
  @ApiProperty({ nullable: true, type: PersonSummaryDto }) actor!: PersonSummaryDto | null;
  @ApiProperty({ description: 'The object to open; the API re-checks access when you do' })
  objectType!: string;
  @ApiProperty() objectId!: string;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Non-sensitive display data only',
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) readAt!: string | null;
}

export class ActivityPageDto {
  @ApiProperty({ type: [ActivityItemDto] }) items!: ActivityItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

/**
 * The unified list of social + operational events for one person. Viewing an item never acts on it
 * (an invitation is not accepted by being seen); "read" is only a read flag.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async list(userId: string, q: ActivityQuery): Promise<ActivityPageDto> {
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.activityItem.findMany({
      where: {
        recipientId: userId,
        ...(q.unread ? { readAt: null } : {}),
        ...keysetBefore('createdAt', decodeCursor(q.cursor)),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    const people = await loadPersonSummaries(
      this.prisma,
      page.items.flatMap((r) => (r.actorId ? [r.actorId] : [])),
    );
    return { items: page.items.map((r) => this.dto(r, people)), nextCursor: page.nextCursor };
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return {
      unread: await this.prisma.activityItem.count({
        where: { recipientId: userId, readAt: null },
      }),
    };
  }

  /** Marks the given items read (owner only). Changes nothing else. */
  async markRead(userId: string, ids: string[]): Promise<{ updated: number }> {
    const res = await this.prisma.activityItem.updateMany({
      where: { recipientId: userId, id: { in: ids }, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: res.count };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.activityItem.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: res.count };
  }

  private dto(r: ActivityItem, people: Map<string, PersonSummaryDto>): ActivityItemDto {
    return {
      id: r.id,
      kind: r.kind,
      actor: r.actorId ? personOrUnknown(people, r.actorId) : null,
      objectType: r.objectType,
      objectId: r.objectId,
      payload: (r.payload as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
      readAt: r.readAt?.toISOString() ?? null,
    };
  }
}
