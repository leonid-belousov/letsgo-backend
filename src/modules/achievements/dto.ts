import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AchievementType } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export const STAFF_GRANTABLE = ['FAIR_PLAY', 'LEADERSHIP', 'TROPHY'] as const;
export type StaffGrantable = (typeof STAFF_GRANTABLE)[number];

export class AchievementsQuery extends PageQuery {}

export class GrantAchievementDto {
  @ApiProperty() @IsUUID() recipientId!: string;
  @ApiProperty({ enum: STAFF_GRANTABLE }) @IsIn(STAFF_GRANTABLE) type!: StaffGrantable;
  @ApiPropertyOptional({ maxLength: 80, description: 'Defaults to the award name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title?: string;
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
  @ApiProperty({ description: 'Basis for the award; recorded in the audit log' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
  @ApiPropertyOptional({ description: 'A CONFIRMED match this award refers to' })
  @IsOptional()
  @IsUUID()
  sourceMatchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceTournamentId?: string;
}

export class RevokeAchievementDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AchievementDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: AchievementType }) type!: AchievementType;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: String }) clubId!: string | null;
  @ApiProperty({ description: 'Club awards are always labelled and never pass for system badges' })
  isClubAward!: boolean;
  @ApiProperty({ nullable: true, type: String }) sourceMatchId!: string | null;
  @ApiProperty({ nullable: true, type: String }) sourceTournamentId!: string | null;
  @ApiProperty() awardedAt!: string;
}

export class UserAchievementsDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ description: 'True ⇒ hidden by the owner; items is then absent' })
  hidden!: boolean;
  @ApiPropertyOptional({ type: [AchievementDto] }) items?: AchievementDto[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor?: string | null;
}

export class StaffAchievementDto extends AchievementDto {
  @ApiProperty() recipientId!: string;
  @ApiProperty({ nullable: true, type: String }) grantedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) revokedAt!: string | null;
}
