import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FavouriteTargetType, FollowTargetType } from '@prisma/client';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { PostDto } from '../posts/dto';

// ───────── follow ─────────
export class FollowStateDto {
  @ApiProperty({ enum: FollowTargetType }) targetType!: FollowTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ enum: ['ACCEPTED', 'REQUESTED', 'NONE'] }) status!:
    'ACCEPTED' | 'REQUESTED' | 'NONE';
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Accepted followers; null when the owner hides the follower list from the viewer',
  })
  followersCount!: number | null;
}

export class UserSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarId!: string | null;
}

export class FollowerItemDto {
  @ApiProperty({ type: UserSummaryDto }) user!: UserSummaryDto;
  @ApiProperty({ format: 'date-time' }) followedAt!: string;
}

export class FollowerPageDto {
  @ApiProperty({ type: [FollowerItemDto] }) items!: FollowerItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty({ description: 'true when the owner hides this list from the viewer' })
  hidden!: boolean;
}

export class FollowingItemDto {
  @ApiProperty({ enum: FollowTargetType }) targetType!: FollowTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiProperty({ format: 'date-time' }) followedAt!: string;
}

export class FollowingPageDto {
  @ApiProperty({ type: [FollowingItemDto] }) items!: FollowingItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hidden!: boolean;
}

export class FollowCountsDto {
  @ApiProperty({ nullable: true, type: Number }) followers!: number | null;
  @ApiProperty({ nullable: true, type: Number }) following!: number | null;
  @ApiProperty({ description: 'Hidden lists also hide the counters' }) hidden!: boolean;
}

export class FollowRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FollowTargetType }) targetType!: FollowTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ type: UserSummaryDto }) requester!: UserSummaryDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class FollowRequestPageDto {
  @ApiProperty({ type: [FollowRequestDto] }) items!: FollowRequestDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class FollowRequestsQuery extends PageQuery {
  @ApiPropertyOptional({
    description:
      'Requests to follow this club (needs club.members.approve); default = requests to follow you',
  })
  @IsOptional()
  @IsUUID()
  clubId?: string;
}

export class RemoveFollowerQuery {
  @ApiPropertyOptional({ description: 'Remove a follower of this club instead of yourself' })
  @IsOptional()
  @IsUUID()
  clubId?: string;
}

// ───────── favourites ─────────
export const FAVOURITE_TABS = ['all', 'people', 'clubs', 'events', 'places'] as const;
export type FavouriteTab = (typeof FAVOURITE_TABS)[number];

export class FavouritesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: FAVOURITE_TABS, default: 'all' })
  @IsOptional()
  @IsIn(FAVOURITE_TABS)
  tab?: FavouriteTab;
}

export class FavouriteEntityDto {
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiProperty({ nullable: true, type: String }) city!: string | null;
}

export class FavouriteItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FavouriteTargetType }) targetType!: FavouriteTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({
    description: 'true → the target is no longer accessible; no details are returned',
  })
  unavailable!: boolean;
  @ApiProperty({ type: FavouriteEntityDto, nullable: true }) entity!: FavouriteEntityDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class FavouritePageDto {
  @ApiProperty({ type: [FavouriteItemDto] }) items!: FavouriteItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class FavouriteStateDto {
  @ApiProperty({ enum: FavouriteTargetType }) targetType!: FavouriteTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty() favourited!: boolean;
}

// ───────── saved posts ─────────
export class SavedPostItemDto {
  @ApiProperty() postId!: string;
  @ApiProperty({ format: 'date-time' }) savedAt!: string;
  @ApiProperty({
    description: 'true → the post can no longer be viewed; no preview or media is returned',
  })
  unavailable!: boolean;
  @ApiProperty({ type: PostDto, nullable: true }) post!: PostDto | null;
}

export class SavedPostPageDto {
  @ApiProperty({ type: [SavedPostItemDto] }) items!: SavedPostItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class SavedStateDto {
  @ApiProperty() postId!: string;
  @ApiProperty() saved!: boolean;
}

// ───────── discovery ─────────
export const DISCOVERY_CATEGORIES = [
  'all',
  'media',
  'people',
  'clubs',
  'tournaments',
  'pitches',
] as const;
export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];

export class DiscoveryQuery extends PageQuery {
  @ApiPropertyOptional({ enum: DISCOVERY_CATEGORIES, default: 'all' })
  @IsOptional()
  @IsIn(DISCOVERY_CATEGORIES)
  category?: DiscoveryCategory;
}

export class EntityCardDto {
  @ApiProperty({ enum: ['PERSON', 'CLUB', 'VENUE', 'PITCH', 'TOURNAMENT'] })
  entityType!: 'PERSON' | 'CLUB' | 'VENUE' | 'PITCH' | 'TOURNAMENT';
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiProperty({ nullable: true, type: String }) city!: string | null;
}

export class FeedItemDto {
  @ApiProperty({ enum: ['POST', 'ENTITY'] }) kind!: 'POST' | 'ENTITY';
  @ApiProperty({ type: PostDto, nullable: true }) post!: PostDto | null;
  @ApiProperty({ type: EntityCardDto, nullable: true }) entity!: EntityCardDto | null;
  @ApiProperty({
    type: [String],
    description:
      'Why it is shown (explainable, no scores): FOLLOWING, FOLLOWS_YOU, SAME_CITY, CLUB_MEMBER, NEW, RECENT',
  })
  reasons!: string[];
}

export class FeedPageDto {
  @ApiProperty({ type: [FeedItemDto] }) items!: FeedItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty({ description: 'true when nextCursor is null: "You’re all caught up"' })
  caughtUp!: boolean;
}
