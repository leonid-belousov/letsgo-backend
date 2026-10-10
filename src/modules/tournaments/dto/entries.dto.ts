import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntryPlayerStatus, EntryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PageQuery } from '../../../common/pagination/cursor-page';
import { PersonSummaryDto } from '../../users/person-summary';
import { ProblemDto } from './tournament.dto';

export class EnterTournamentDto {
  @ApiProperty({
    description: 'The club to enter with - you must hold club.tournaments.enter on it',
  })
  @IsUUID()
  clubId!: string;
}

export class InviteClubDto {
  @ApiProperty() @IsUUID() clubId!: string;
}

export class RespondInvitationDto {
  @ApiProperty() @IsBoolean() accept!: boolean;
}

export class DecideEntryDto {
  @ApiProperty({ enum: ['ACCEPT', 'REJECT'] }) @IsIn(['ACCEPT', 'REJECT']) decision!:
    'ACCEPT' | 'REJECT';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class EntryListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: EntryStatus })
  @IsOptional()
  @IsEnum(EntryStatus)
  status?: EntryStatus;
}

export class InvitePlayersDto {
  @ApiProperty({ type: [String], description: 'Several people at once' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds!: string[];
  @ApiPropertyOptional({ description: 'Guests keep their own club membership' })
  @IsOptional()
  @IsBoolean()
  isGuest?: boolean;
}

export class AgeExceptionDecisionDto {
  @ApiProperty() @IsBoolean() approve!: boolean;
  @ApiPropertyOptional({
    description: 'Reason is recorded with author, time and scope (this tournament)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SquadQuery {
  @ApiPropertyOptional({ enum: EntryPlayerStatus })
  @IsOptional()
  @IsEnum(EntryPlayerStatus)
  status?: EntryPlayerStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

// ───────────── responses ─────────────

export class ClubRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() username!: string;
}

export class SquadCountsDto {
  @ApiProperty() confirmed!: number;
  @ApiProperty() invited!: number;
  @ApiProperty({
    description: 'Confirmed, age-eligible and consented to every mandatory player document',
  })
  eligible!: number;
  @ApiProperty({ nullable: true, type: Number }) min!: number | null;
  @ApiProperty({ nullable: true, type: Number }) max!: number | null;
}

export class SquadPlayerDto {
  @ApiProperty({ type: PersonSummaryDto }) person!: PersonSummaryDto;
  @ApiProperty({ enum: EntryPlayerStatus }) status!: EntryPlayerStatus;
  @ApiProperty() isGuest!: boolean;
  @ApiProperty({ enum: ['ELIGIBLE', 'EXCEPTION_REQUIRED', 'NOT_ALLOWED', 'UNKNOWN_DOB'] })
  ageEligibility!: string;
  @ApiProperty({
    description: 'The organiser approved this age exception (invitations never bypass it)',
  })
  ageExceptionApproved!: boolean;
  @ApiProperty({
    type: [String],
    description: 'Mandatory player documents this person has not accepted',
  })
  missingDocumentIds!: string[];
  @ApiProperty({ type: String, format: 'date-time' }) invitedAt!: string;
}

export class EntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() tournamentId!: string;
  @ApiProperty({ type: ClubRefDto }) club!: ClubRefDto;
  @ApiProperty({ enum: EntryStatus }) status!: EntryStatus;
  @ApiProperty() submittedById!: string;
  @ApiProperty({ nullable: true, type: String }) decidedById!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ type: SquadCountsDto }) squad!: SquadCountsDto;
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description: 'Accepted AND squad/documents/schedule ready. null unless ACCEPTED',
  })
  ready!: boolean | null;
  @ApiProperty({ type: [ProblemDto], description: 'Why the club is not Ready (empty when ready)' })
  problems!: ProblemDto[];
}

export class EntryPageDto {
  @ApiProperty({ type: [EntryDto] }) items!: EntryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class SquadDto {
  @ApiProperty({ type: EntryDto }) entry!: EntryDto;
  @ApiProperty({ type: [SquadPlayerDto] }) players!: SquadPlayerDto[];
}

export class SkippedDto {
  @ApiProperty() userId!: string;
  @ApiProperty({
    enum: [
      'NOT_FOUND',
      'NOT_ALLOWED',
      'NOT_A_MEMBER',
      'AGE_NOT_ALLOWED',
      'DOB_REQUIRED',
      'ALREADY_IN_SQUAD',
      'ALREADY_IN_OTHER_SQUAD',
    ],
  })
  reason!: string;
}

export class InvitePlayersResultDto {
  @ApiProperty({ type: [SquadPlayerDto] }) invited!: SquadPlayerDto[];
  @ApiProperty({ type: [SkippedDto] }) skipped!: SkippedDto[];
}

export class MyPlayerDto {
  @ApiProperty() tournamentId!: string;
  @ApiProperty() entryId!: string;
  @ApiProperty({ type: ClubRefDto }) club!: ClubRefDto;
  @ApiProperty({ enum: EntryPlayerStatus }) status!: EntryPlayerStatus;
  @ApiProperty() isGuest!: boolean;
  @ApiProperty() ageEligibility!: string;
  @ApiProperty() ageExceptionApproved!: boolean;
  @ApiProperty({ type: [String] }) missingDocumentIds!: string[];
  @ApiProperty({
    description: 'A confirmed place may need the organiser to approve an age exception first',
  })
  canConfirm!: boolean;
}
