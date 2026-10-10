import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export const SEARCH_TYPES = [
  'people',
  'clubs',
  'venues',
  'pitches',
  'tournaments',
  'events',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const ENTITY_TYPES = ['PERSON', 'CLUB', 'VENUE', 'PITCH', 'TOURNAMENT', 'EVENT'] as const;
export type SearchEntityType = (typeof ENTITY_TYPES)[number];

export class SearchQuery extends PageQuery {
  @ApiProperty({
    minLength: 1,
    maxLength: 80,
    description: 'A leading @ restricts matching to handles',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  q!: string;

  @ApiPropertyOptional({
    enum: SEARCH_TYPES,
    description: 'Omit for the grouped overview (≤ 4 per type + totals)',
  })
  @IsOptional()
  @IsIn(SEARCH_TYPES)
  type?: SearchType;
}

export class SearchResultDto {
  @ApiProperty({ enum: ENTITY_TYPES }) entityType!: SearchEntityType;
  @ApiProperty({ description: 'Stable id; the same nickname can belong to many different people' })
  id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String, description: '@username / club username' })
  handle!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'City (clubs, venues, pitches, tournaments, events)',
  })
  subtitle!: string | null;
}

export class SearchSectionDto {
  @ApiProperty({ enum: SEARCH_TYPES }) type!: SearchType;
  @ApiProperty({ enum: ENTITY_TYPES }) entityType!: SearchEntityType;
  @ApiProperty({ type: [SearchResultDto] }) items!: SearchResultDto[];
  @ApiProperty({ description: 'True number of matches visible to the viewer ("View all N")' })
  total!: number;
}

export class SearchResponseDto {
  @ApiProperty() q!: string;
  @ApiProperty({ enum: SEARCH_TYPES, nullable: true, type: String }) type!: SearchType | null;
  @ApiProperty({
    type: [SearchSectionDto],
    nullable: true,
    description: 'Overview mode (no `type`)',
  })
  sections!: SearchSectionDto[] | null;
  @ApiProperty({ type: [SearchResultDto], nullable: true, description: 'Typed mode' })
  items!: SearchResultDto[] | null;
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Typed mode: total matches' })
  total!: number | null;
}

// ───────── recent searches ─────────
export class RecordRecentDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80, description: 'Free-text query (2-80 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({
    enum: ENTITY_TYPES,
    description: 'With entityId: a result the user opened',
  })
  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: SearchEntityType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  entityId?: string;
}

export class RecentEntityDto {
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiProperty({ nullable: true, type: String }) subtitle!: string | null;
}

export class RecentSearchDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['QUERY', 'ENTITY'] }) kind!: 'QUERY' | 'ENTITY';
  @ApiProperty({ nullable: true, type: String }) query!: string | null;
  @ApiProperty({ enum: ENTITY_TYPES, nullable: true, type: String })
  entityType!: SearchEntityType | null;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({
    description: 'true → hidden/deleted/blocked now; no name, handle or city is returned',
  })
  unavailable!: boolean;
  @ApiProperty({ type: RecentEntityDto, nullable: true }) entity!: RecentEntityDto | null;
  @ApiProperty({ format: 'date-time' }) lastUsedAt!: string;
}

export class RecentSearchListDto {
  @ApiProperty({ type: [RecentSearchDto], description: 'Newest first, at most 20' })
  items!: RecentSearchDto[];
}
