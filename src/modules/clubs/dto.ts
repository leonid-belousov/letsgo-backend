import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClubJoinMode, ClubStatus, ClubVisibility, MembershipStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export const CLUB_FORMATS = ['5v5', '6v6', '7v7', '8v8', '9v9', '10v10', '11v11'] as const;
export const CLUB_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.]{2,29}$/;
export const CLUB_NAME_MAX = 60;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateClubDto {
  @ApiProperty({ maxLength: CLUB_NAME_MAX, description: 'Trimmed; Unicode allowed' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CLUB_NAME_MAX)
  name!: string;

  @ApiProperty({
    pattern: CLUB_USERNAME_PATTERN.source,
    description: 'Unique among clubs, case-insensitive; stored lowercase',
  })
  @Transform(trimLower)
  @IsString()
  @Matches(CLUB_USERNAME_PATTERN, {
    message: 'username must be 3-30 chars: lowercase letters, digits, _ or . (no leading _ or .)',
  })
  username!: string;

  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  about?: string;

  @ApiPropertyOptional({ enum: CLUB_FORMATS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(CLUB_FORMATS, { each: true })
  preferredFormats?: string[];

  @ApiPropertyOptional({ enum: ClubVisibility, default: 'PUBLIC' })
  @IsOptional()
  @IsEnum(ClubVisibility)
  visibility?: ClubVisibility;

  @ApiPropertyOptional({ enum: ClubJoinMode, default: 'APPROVE_REQUESTS' })
  @IsOptional()
  @IsEnum(ClubJoinMode)
  joinMode?: ClubJoinMode;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Own READY photo asset; omitted or null keeps the initials fallback',
  })
  @IsOptional()
  @IsUUID()
  logoMediaId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Own READY photo asset; omitted or null keeps the initials fallback',
  })
  @IsOptional()
  @IsUUID()
  coverMediaId?: string | null;
}

export class UpdateClubDto {
  @ApiPropertyOptional({ maxLength: CLUB_NAME_MAX })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CLUB_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  about?: string;

  @ApiPropertyOptional({ enum: CLUB_FORMATS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(CLUB_FORMATS, { each: true })
  preferredFormats?: string[];

  @ApiPropertyOptional({ enum: ClubVisibility })
  @IsOptional()
  @IsEnum(ClubVisibility)
  visibility?: ClubVisibility;

  @ApiPropertyOptional({ enum: ClubJoinMode })
  @IsOptional()
  @IsEnum(ClubJoinMode)
  joinMode?: ClubJoinMode;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Own READY photo asset; null clears the logo',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  logoMediaId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Own READY photo asset; null clears the cover',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  coverMediaId?: string | null;

  @ApiProperty({ description: 'Current `version`; stale value → 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;
}

export class UsernameAvailabilityQuery {
  @ApiProperty()
  @Transform(trimLower)
  @IsString()
  @MaxLength(40)
  username!: string;
}

export class ClubUsernameAvailabilityDto {
  @ApiProperty() username!: string;
  @ApiProperty() available!: boolean;
  @ApiProperty({ description: 'False when the handle does not match the allowed pattern' })
  valid!: boolean;
}

export class ClubSearchQuery extends PageQuery {
  @ApiPropertyOptional({
    description: 'Matches club name or username (substring, case-insensitive)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  city?: string;
}

export class ClubCapabilitiesDto {
  @ApiProperty() canJoin!: boolean;
  @ApiProperty() canRequestToJoin!: boolean;
  @ApiProperty() canCancelRequest!: boolean;
  @ApiProperty() canAcceptInvitation!: boolean;
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canInvite!: boolean;
  @ApiProperty() canApprove!: boolean;
  @ApiProperty() canRemoveMembers!: boolean;
  @ApiProperty() canManageRoles!: boolean;
  @ApiProperty() canManageAwards!: boolean;
  @ApiProperty() canTransferOwnership!: boolean;
  @ApiProperty() canArchive!: boolean;
  @ApiProperty() canLeave!: boolean;
}

export class MyMembershipDto {
  @ApiProperty({ enum: MembershipStatus }) status!: MembershipStatus;
  @ApiProperty({ nullable: true, type: String }) roleTitle!: string | null;
  @ApiProperty() isOwner!: boolean;
}

/**
 * Viewer-aware club. For a PRIVATE club a non-member gets `restricted: true` and only
 * name / username / city / logo; the optional fields are then absent (not blanked).
 */
export class ClubDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CLUB'], description: 'Entity type; a handle is never a key of authority' })
  entityType!: 'CLUB';
  @ApiProperty() name!: string;
  @ApiProperty() username!: string;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty({ enum: ClubVisibility }) visibility!: ClubVisibility;
  @ApiProperty({ enum: ClubStatus }) status!: ClubStatus;
  @ApiProperty({ description: 'True when only the public card of a private club is shown' })
  restricted!: boolean;
  @ApiPropertyOptional({ nullable: true, type: String }) about?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) coverMediaId?: string | null;
  @ApiPropertyOptional({ enum: ClubJoinMode }) joinMode?: ClubJoinMode;
  @ApiPropertyOptional({ type: [String] }) preferredFormats?: string[];
  @ApiPropertyOptional() memberCount?: number;
  @ApiPropertyOptional() founderId?: string;
  @ApiPropertyOptional() ownerId?: string;
  @ApiPropertyOptional({ description: 'Only for holders of club.profile.edit' }) version?: number;
  @ApiProperty({ type: MyMembershipDto, nullable: true }) myMembership!: MyMembershipDto | null;
  @ApiProperty({ type: ClubCapabilitiesDto }) capabilities!: ClubCapabilitiesDto;
}

/** Search / list card. Private clubs expose the name card only. */
export class ClubSearchItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CLUB'] }) entityType!: 'CLUB';
  @ApiProperty() name!: string;
  @ApiProperty() username!: string;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty({ enum: ClubVisibility }) visibility!: ClubVisibility;
  @ApiPropertyOptional({ description: 'Public clubs only' }) memberCount?: number;
  @ApiPropertyOptional({ enum: ClubJoinMode, description: 'Public clubs only' })
  joinMode?: ClubJoinMode;
}

export class ClubSearchPageDto {
  @ApiProperty({ type: [ClubSearchItemDto] }) items!: ClubSearchItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class MyClubItemDto extends ClubSearchItemDto {
  @ApiProperty({ enum: ClubStatus }) status!: ClubStatus;
  @ApiProperty() isOwner!: boolean;
  @ApiProperty({ nullable: true, type: String }) roleTitle!: string | null;
}

export class MyClubsPageDto {
  @ApiProperty({ type: [MyClubItemDto] }) items!: MyClubItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

// ───────────── membership ─────────────

export class MembershipResultDto {
  @ApiProperty() clubId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: MembershipStatus }) status!: MembershipStatus;
}

export class InviteMembersDto {
  @ApiProperty({ type: [String], description: 'Multi-select; one call may invite many people' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds!: string[];
}

export const INVITE_OUTCOMES = [
  'INVITED',
  'ALREADY_MEMBER',
  'ALREADY_INVITED',
  'ALREADY_REQUESTED',
  'NOT_ALLOWED',
  'NOT_FOUND',
] as const;
export type InviteOutcome = (typeof INVITE_OUTCOMES)[number];

export class InviteResultItemDto {
  @ApiProperty() userId!: string;
  @ApiProperty({
    enum: INVITE_OUTCOMES,
    description:
      'NOT_ALLOWED covers blocked users and the invitee’s invitation policy without revealing which',
  })
  outcome!: InviteOutcome;
}

export class InviteResultDto {
  @ApiProperty({ type: [InviteResultItemDto] }) results!: InviteResultItemDto[];
}

export class SetMemberTitleDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 40,
    description: 'Free display text. Grants nothing. null clears it.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  roleTitle?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() showTitle?: boolean;
}

export class MemberDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['PERSON'] }) entityType!: 'PERSON';
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarId!: string | null;
  @ApiProperty({ enum: MembershipStatus }) status!: MembershipStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Display text only' })
  roleTitle!: string | null;
  @ApiProperty() isOwner!: boolean;
  @ApiProperty() isFounder!: boolean;
  @ApiProperty({ nullable: true, type: String }) joinedAt!: string | null;
  @ApiProperty() requestedOrInvitedAt!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) invitedById?: string | null;
}

export class MemberPageDto {
  @ApiProperty({ type: [MemberDto] }) items!: MemberDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class MyClubInvitationDto {
  @ApiProperty() clubId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() username!: string;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty({ nullable: true, type: String }) invitedById!: string | null;
  @ApiProperty() invitedAt!: string;
}

export class MyInvitationPageDto {
  @ApiProperty({ type: [MyClubInvitationDto] }) items!: MyClubInvitationDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

// ───────────── ownership transfer ─────────────

export class CreateTransferDto {
  @ApiProperty({ description: 'Specific active user who will become the owner if they accept' })
  @IsUUID()
  toUserId!: string;
}

export class OwnershipTransferDto {
  @ApiProperty() id!: string;
  @ApiProperty() clubId!: string;
  @ApiProperty() fromUserId!: string;
  @ApiProperty() toUserId!: string;
  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'] })
  status!: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) respondedAt!: string | null;
}

export class OwnershipTransferListDto {
  @ApiProperty({ type: [OwnershipTransferDto] }) items!: OwnershipTransferDto[];
}

// ───────────── awards ─────────────

export class CreateClubAwardDto {
  @ApiProperty() @IsUUID() recipientId!: string;

  @ApiProperty({ maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ClubAwardDto {
  @ApiProperty() id!: string;
  @ApiProperty() clubId!: string;
  @ApiProperty({
    enum: ['CLUB_AWARD'],
    description: 'Club awards are labelled as such and never affect official statistics',
  })
  type!: 'CLUB_AWARD';
  @ApiProperty({ description: 'Always true: awarded by the club, not by Let’sGo' })
  clubAward!: true;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() recipientId!: string;
  @ApiProperty({ nullable: true, type: String }) grantedById!: string | null;
  @ApiProperty() awardedAt!: string;
}

export class ClubAwardPageDto {
  @ApiProperty({ type: [ClubAwardDto] }) items!: ClubAwardDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ClubIdParam {
  @ApiProperty() @Type(() => String) @IsUUID() id!: string;
}
