import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MediaKind,
  MentionStatus,
  MentionTargetType,
  PostAudience,
  PostAuthorType,
  PostStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PageQuery } from '../../common/pagination/cursor-page';

export const POST_TEXT_MAX = 2000;
export const POST_MEDIA_MAX = 10;
export const COMMENT_TEXT_MAX = 1000;
export const MENTIONS_MAX = 20;

export class MentionInputDto {
  @ApiProperty({ enum: MentionTargetType })
  @IsEnum(MentionTargetType)
  targetType!: MentionTargetType;
  @ApiProperty() @IsUUID() targetId!: string;
}

export class CreatePostDto {
  @ApiPropertyOptional({ enum: PostAuthorType, default: 'USER', description: '"Post as"' })
  @IsOptional()
  @IsEnum(PostAuthorType)
  authorType?: PostAuthorType;

  @ApiPropertyOptional({ description: 'Club / tournament / venue id when not posting as yourself' })
  @IsOptional()
  @IsUUID()
  authorEntityId?: string;

  @ApiPropertyOptional({ maxLength: POST_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(POST_TEXT_MAX)
  text?: string;

  @ApiPropertyOptional({ enum: PostAudience, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(PostAudience)
  audience?: PostAudience;

  @ApiPropertyOptional({
    type: [String],
    description: 'READY media owned by you, in display order',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POST_MEDIA_MAX)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  mediaIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsUUID() achievementId?: string;

  @ApiPropertyOptional({ type: [MentionInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENTIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => MentionInputDto)
  mentions?: MentionInputDto[];

  @ApiPropertyOptional({ default: true, description: 'false stores a DRAFT' })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdatePostDto {
  @ApiProperty({ description: 'Current version; stale → 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;

  @ApiPropertyOptional({ maxLength: POST_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(POST_TEXT_MAX)
  text?: string;

  @ApiPropertyOptional({ enum: PostAudience })
  @IsOptional()
  @IsEnum(PostAudience)
  audience?: PostAudience;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POST_MEDIA_MAX)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({ type: [MentionInputDto], description: 'Replaces the structured mentions' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENTIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => MentionInputDto)
  mentions?: MentionInputDto[];
}

export class SetCommentsClosedDto {
  @ApiProperty() @IsBoolean() closed!: boolean;
}

export class ListPostsQuery extends PageQuery {
  @ApiProperty({ enum: PostAuthorType }) @IsEnum(PostAuthorType) authorType!: PostAuthorType;
  @ApiProperty() @IsUUID() authorEntityId!: string;
}

export class TaggedPostsQuery extends PageQuery {
  @ApiProperty({ enum: MentionTargetType })
  @IsEnum(MentionTargetType)
  targetType!: MentionTargetType;
  @ApiProperty() @IsUUID() targetId!: string;
}

export class PostAuthorDto {
  @ApiProperty({ enum: PostAuthorType }) type!: PostAuthorType;
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Avatar (person) or logo (club) media id; fetch via /media/:id/url?variant=thumb',
  })
  avatarId!: string | null;
}

export class PostMediaDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MediaKind }) kind!: MediaKind;
  @ApiProperty() position!: number;
}

export class PostCountsDto {
  @ApiProperty() likes!: number;
  @ApiProperty() comments!: number;
}

export class PostViewerStateDto {
  @ApiProperty() liked!: boolean;
  @ApiProperty() saved!: boolean;
}

export class PostCapabilitiesDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canDelete!: boolean;
  @ApiProperty() canComment!: boolean;
  @ApiProperty() canLike!: boolean;
  @ApiProperty() canReport!: boolean;
  @ApiProperty() canManageComments!: boolean;
  @ApiProperty({
    description: 'Whether the viewer may save attached media outside the app',
  })
  canSaveMedia!: boolean;
}

export class PostMentionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MentionTargetType }) targetType!: MentionTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) handle!: string | null;
  @ApiPropertyOptional({ enum: MentionStatus, description: 'Only shown to the post editor' })
  status?: MentionStatus;
}

export class PostDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
  @ApiProperty({ enum: PostAudience }) audience!: PostAudience;
  @ApiProperty({ enum: PostStatus }) status!: PostStatus;
  @ApiProperty({ nullable: true, type: String }) text!: string | null;
  @ApiProperty({
    type: [PostMediaDto],
    description: 'Ids and kinds only; URLs via /v1/media/:id/url',
  })
  media!: PostMediaDto[];
  @ApiProperty({ nullable: true, type: String }) achievementId!: string | null;
  @ApiProperty({ type: [PostMentionDto] }) mentions!: PostMentionDto[];
  @ApiProperty({ type: PostCountsDto }) counts!: PostCountsDto;
  @ApiProperty({ type: PostViewerStateDto }) viewer!: PostViewerStateDto;
  @ApiProperty({ type: PostCapabilitiesDto }) capabilities!: PostCapabilitiesDto;
  @ApiProperty() commentsClosed!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PostPageDto {
  @ApiProperty({ type: [PostDto] }) items!: PostDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class LikeStateDto {
  @ApiProperty() liked!: boolean;
  @ApiProperty() likes!: number;
}

// ───────── comments ─────────
export class CreateCommentDto {
  @ApiProperty({ maxLength: COMMENT_TEXT_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_TEXT_MAX)
  body!: string;

  @ApiPropertyOptional({ description: 'Top-level comment id (one level of replies only)' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class EditCommentDto {
  @ApiProperty({ maxLength: COMMENT_TEXT_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_TEXT_MAX)
  body!: string;
}

export class CommentsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'List replies of this top-level comment instead' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class CommentAuthorDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
}

export class CommentCapabilitiesDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canDelete!: boolean;
  @ApiProperty() canReply!: boolean;
}

export class CommentDto {
  @ApiProperty() id!: string;
  @ApiProperty() postId!: string;
  @ApiProperty({ nullable: true, type: String }) parentId!: string | null;
  @ApiProperty({ type: CommentAuthorDto }) author!: CommentAuthorDto;
  @ApiProperty() body!: string;
  @ApiProperty() replyCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) editedAt!: string | null;
  @ApiProperty({ type: CommentCapabilitiesDto }) capabilities!: CommentCapabilitiesDto;
}

export class CommentPageDto {
  @ApiProperty({ type: [CommentDto] }) items!: CommentDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

// ───────── tag requests ─────────
export const TAG_DECISIONS = ['SHOW', 'HIDE', 'REMOVE'] as const;
export type TagDecision = (typeof TAG_DECISIONS)[number];

export class DecideTagDto {
  @ApiProperty({ enum: TAG_DECISIONS }) @IsIn(TAG_DECISIONS) decision!: TagDecision;
}

export class TagRequestsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: MentionStatus, default: 'PENDING_REVIEW' })
  @IsOptional()
  @IsEnum(MentionStatus)
  status?: MentionStatus;
}

export class TagRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty() postId!: string;
  @ApiProperty({ enum: MentionTargetType }) targetType!: MentionTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Display name of the tagged person/club',
  })
  targetName!: string | null;
  @ApiProperty({ nullable: true, type: String }) targetHandle!: string | null;
  @ApiProperty({ enum: MentionStatus }) status!: MentionStatus;
  @ApiProperty({
    type: PostAuthorDto,
    description: 'Identity of who posted (public identity only)',
  })
  postedBy!: PostAuthorDto;
  @ApiProperty({
    type: PostDto,
    nullable: true,
    description: 'Only when the reviewer may view the post; a mention never widens the audience',
  })
  post!: PostDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class TagRequestPageDto {
  @ApiProperty({ type: [TagRequestDto] }) items!: TagRequestDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
