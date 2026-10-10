import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Audience,
  InvitationPolicy,
  MentionPolicy,
  MessagePolicy,
  PrivacyPolicy,
  ProfileVisibility,
} from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

export class PrivacyDto {
  @ApiProperty({ enum: ProfileVisibility }) profileVisibility!: ProfileVisibility;
  @ApiProperty({ enum: Audience }) postsAudience!: Audience;
  @ApiProperty({ enum: Audience }) historyAudience!: Audience;
  @ApiProperty({ enum: Audience }) statsAudience!: Audience;
  @ApiProperty({ enum: Audience }) awardsAudience!: Audience;
  @ApiProperty({ enum: Audience }) clubsAudience!: Audience;
  @ApiProperty({ enum: Audience }) ratingsAudience!: Audience;
  @ApiProperty({ enum: Audience }) cityAudience!: Audience;
  @ApiProperty({ enum: Audience }) ageAudience!: Audience;
  @ApiProperty({ enum: Audience }) followListAudience!: Audience;
  @ApiProperty({ enum: MessagePolicy }) messagePolicy!: MessagePolicy;
  @ApiProperty({ enum: InvitationPolicy }) invitationPolicy!: InvitationPolicy;
  @ApiProperty({ enum: MentionPolicy }) mentionPolicy!: MentionPolicy;
  @ApiProperty() reviewTags!: boolean;
  @ApiProperty() externalMediaSharing!: boolean;

  static from(p: PrivacyPolicy, visibility: ProfileVisibility): PrivacyDto {
    return {
      profileVisibility: visibility,
      postsAudience: p.postsAudience,
      historyAudience: p.historyAudience,
      statsAudience: p.statsAudience,
      awardsAudience: p.awardsAudience,
      clubsAudience: p.clubsAudience,
      ratingsAudience: p.ratingsAudience,
      cityAudience: p.cityAudience,
      ageAudience: p.ageAudience,
      followListAudience: p.followListAudience,
      messagePolicy: p.messagePolicy,
      invitationPolicy: p.invitationPolicy,
      mentionPolicy: p.mentionPolicy,
      reviewTags: p.reviewTags,
      externalMediaSharing: p.externalMediaSharing,
    };
  }
}

export class UpdatePrivacyDto {
  @ApiPropertyOptional({ enum: ProfileVisibility })
  @IsOptional()
  @IsEnum(ProfileVisibility)
  profileVisibility?: ProfileVisibility;
  @ApiPropertyOptional({ enum: Audience }) @IsOptional() @IsEnum(Audience) postsAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience })
  @IsOptional()
  @IsEnum(Audience)
  historyAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience }) @IsOptional() @IsEnum(Audience) statsAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience })
  @IsOptional()
  @IsEnum(Audience)
  awardsAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience }) @IsOptional() @IsEnum(Audience) clubsAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience })
  @IsOptional()
  @IsEnum(Audience)
  ratingsAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience }) @IsOptional() @IsEnum(Audience) cityAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience }) @IsOptional() @IsEnum(Audience) ageAudience?: Audience;
  @ApiPropertyOptional({ enum: Audience })
  @IsOptional()
  @IsEnum(Audience)
  followListAudience?: Audience;
  @ApiPropertyOptional({ enum: MessagePolicy })
  @IsOptional()
  @IsEnum(MessagePolicy)
  messagePolicy?: MessagePolicy;
  @ApiPropertyOptional({ enum: InvitationPolicy })
  @IsOptional()
  @IsEnum(InvitationPolicy)
  invitationPolicy?: InvitationPolicy;
  @ApiPropertyOptional({ enum: MentionPolicy })
  @IsOptional()
  @IsEnum(MentionPolicy)
  mentionPolicy?: MentionPolicy;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() reviewTags?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() externalMediaSharing?: boolean;
}

export class BlockedUserDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ type: String, nullable: true }) nickname!: string | null;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty() blockedAt!: string;
}
