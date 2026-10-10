import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsUUID,
  ValidateIf,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.]{2,29}$/;

export class UserCapabilitiesDto {
  @ApiProperty() canFollow!: boolean;
  @ApiProperty() canUnfollow!: boolean;
  @ApiProperty() canMessage!: boolean;
  @ApiProperty() canFavourite!: boolean;
  @ApiProperty() canBlock!: boolean;
  @ApiProperty() canReport!: boolean;
}

/** What anyone the audience rules allow may see about a person. Never includes DOB/contacts. */
export class PublicProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarId!: string | null;
  @ApiProperty({ enum: ProfileVisibility }) visibility!: ProfileVisibility;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Present only if the city audience allows the viewer',
  })
  city?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Present only for allowed viewers of a readable profile',
  })
  bio?: string | null;
  @ApiPropertyOptional({
    type: Number,
    description: 'Age in years (never the DOB); only if the age audience allows the viewer',
  })
  age?: number;
  @ApiProperty({
    enum: ['ACCEPTED', 'REQUESTED'],
    nullable: true,
    type: String,
    description: "Viewer's follow state",
  })
  followStatus!: 'ACCEPTED' | 'REQUESTED' | null;
  @ApiProperty({ type: UserCapabilitiesDto }) capabilities!: UserCapabilitiesDto;
}

export class OwnerProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) dateOfBirth!: string | null;
  @ApiProperty({ nullable: true, type: String }) city!: string | null;
  @ApiProperty({ nullable: true, type: String }) bio!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarId!: string | null;
  @ApiProperty({ enum: ProfileVisibility }) visibility!: ProfileVisibility;
  @ApiProperty() profileComplete!: boolean;
  @ApiProperty({ description: 'Optimistic concurrency token; send back as `version`' })
  version!: number;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  nickname?: string;

  @ApiPropertyOptional({ description: 'Unique among people, case-insensitive; stored lowercase' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.]{2,29}$/, {
    message: 'username must be 3-30 chars: letters, digits, _ or .',
  })
  username?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dateOfBirth?: Date;

  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) bio?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Own READY photo asset to use as avatar; null removes the avatar',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  avatarId?: string | null;

  @ApiPropertyOptional({ description: 'If set and stale → 409 VERSION_CHANGED' })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class UsernameAvailabilityDto {
  @ApiProperty() username!: string;
  @ApiProperty() available!: boolean;
}
