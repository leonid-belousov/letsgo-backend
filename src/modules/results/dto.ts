import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MatchEventType, MatchStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { PersonSummaryDto } from '../users/person-summary';

// ───────────── requests ─────────────

export class CreateMatchDto {
  @ApiProperty() @IsUUID() homeTeamId!: string;
  @ApiProperty() @IsUUID() awayTeamId!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;
  @ApiPropertyOptional({ description: 'Plain score mode (no scorers). Both or neither.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  homeScore?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  awayScore?: number;
}

export class MatchEventInputDto {
  @ApiProperty({ enum: MatchEventType }) @IsEnum(MatchEventType) type!: MatchEventType;
  @ApiProperty({
    description: 'The player the event is about (scorer, card receiver, own-goal scorer)',
  })
  @IsUUID()
  playerId!: string;
  @ApiPropertyOptional({ description: 'GOAL only; a different person from the scorer' })
  @IsOptional()
  @IsUUID()
  assistById?: string;
  @ApiPropertyOptional({
    description:
      'The player’s own team. Required for goals when the player has no team assignment. An OWN_GOAL counts for the opponent.',
  })
  @IsOptional()
  @IsUUID()
  teamId?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  minute?: number;
}

export class AddMatchEventDto extends MatchEventInputDto {
  @ApiPropertyOptional({ description: '409 VERSION_CHANGED when stale' })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class SetScoreDto {
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  homeScore?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  awayScore?: number | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  version?: number;
}

export class SubmitMatchDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

export class ConfirmMatchDto {
  @ApiProperty({
    description: 'The version the confirmer reviewed; 409 VERSION_CHANGED when it moved',
  })
  @IsInt()
  version!: number;
}

export class CancelMatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

export class CorrectMatchDto {
  @ApiProperty({
    description: 'Mandatory reason; stored in the immutable revision and the audit log',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
  @ApiProperty() @IsInt() version!: number;
  @ApiPropertyOptional({
    type: [MatchEventInputDto],
    description: 'Full replacement of the match events (scores are derived from goals)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MatchEventInputDto)
  events?: MatchEventInputDto[];
  @ApiPropertyOptional({
    description: 'Direct score; only when the resulting events contain no goals',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  homeScore?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  awayScore?: number;
}

export class VoteMvpDto {
  @ApiProperty() @IsUUID() candidateId!: string;
}

export class DecideMvpDto {
  @ApiProperty() @IsUUID() mvpUserId!: string;
}

export class SetCaptainDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'null clears the captain' })
  @IsOptional()
  @IsUUID()
  userId?: string | null;
}

export class HistoryQuery extends PageQuery {}

// ───────────── responses ─────────────

export class MatchTeamDto {
  @ApiProperty() id!: string;
  @ApiProperty() index!: number;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) colour!: string | null;
  @ApiProperty({ nullable: true, type: String }) clubId!: string | null;
  @ApiProperty({ nullable: true, type: String }) captainId!: string | null;
}

export class MatchEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MatchEventType }) type!: MatchEventType;
  @ApiProperty({ nullable: true, type: String }) teamId!: string | null;
  @ApiProperty({ type: PersonSummaryDto }) player!: PersonSummaryDto;
  @ApiProperty({ type: PersonSummaryDto, nullable: true }) assistBy!: PersonSummaryDto | null;
  @ApiProperty({ nullable: true, type: Number }) minute!: number | null;
  @ApiProperty() recordedById!: string;
  @ApiProperty() createdAt!: string;
}

export class MvpLeaderDto {
  @ApiProperty() userId!: string;
  @ApiProperty() votes!: number;
}

export class MvpSummaryDto {
  @ApiProperty({ description: 'False for unconfirmed/cancelled matches (voting never opened)' })
  votingOpened!: boolean;
  @ApiProperty() votingOpen!: boolean;
  @ApiProperty({ nullable: true, type: String }) closesAt!: string | null;
  @ApiProperty({
    type: [MvpLeaderDto],
    description: 'Leader(s); only after the voting window closed',
  })
  leaders!: MvpLeaderDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null: no votes, or a tie awaiting the organiser’s decision',
  })
  mvpUserId!: string | null;
  @ApiProperty() needsDecision!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'The viewer’s own vote' })
  myVote!: string | null;
}

export class MatchCapabilitiesDto {
  @ApiProperty() canRecordEvents!: boolean;
  @ApiProperty() canSetScore!: boolean;
  @ApiProperty() canSubmit!: boolean;
  @ApiProperty() canConfirm!: boolean;
  @ApiProperty() canCorrect!: boolean;
  @ApiProperty() canCancel!: boolean;
  @ApiProperty() canVoteMvp!: boolean;
  @ApiProperty() canDecideMvp!: boolean;
}

export class MatchDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ enum: MatchStatus }) status!: MatchStatus;
  @ApiProperty() version!: number;
  @ApiProperty({ type: MatchTeamDto, nullable: true }) homeTeam!: MatchTeamDto | null;
  @ApiProperty({ type: MatchTeamDto, nullable: true }) awayTeam!: MatchTeamDto | null;
  @ApiProperty({ nullable: true, type: Number }) homeScore!: number | null;
  @ApiProperty({ nullable: true, type: Number }) awayScore!: number | null;
  @ApiProperty({ enum: ['EVENTS', 'DIRECT'], nullable: true, type: String })
  scoreSource!: 'EVENTS' | 'DIRECT' | null;
  @ApiProperty({ nullable: true, type: String }) startsAt!: string | null;
  @ApiProperty({ type: [MatchEventDto] }) events!: MatchEventDto[];
  @ApiProperty({ nullable: true, type: String }) confirmedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) confirmedAt!: string | null;
  @ApiProperty({ description: 'Number of corrections made after confirmation' })
  revisionCount!: number;
  @ApiProperty({ type: MvpSummaryDto }) mvp!: MvpSummaryDto;
  @ApiProperty({ type: MatchCapabilitiesDto }) capabilities!: MatchCapabilitiesDto;
}

export class MatchListDto {
  @ApiProperty({ type: [MatchDto] }) items!: MatchDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class RevisionSnapshotEventDto {
  @ApiProperty() type!: string;
  @ApiProperty({ nullable: true, type: String }) teamId!: string | null;
  @ApiProperty() playerId!: string;
  @ApiProperty({ nullable: true, type: String }) assistById!: string | null;
  @ApiProperty({ nullable: true, type: Number }) minute!: number | null;
}

export class RevisionSnapshotDto {
  @ApiProperty({ nullable: true, type: Number }) homeScore!: number | null;
  @ApiProperty({ nullable: true, type: Number }) awayScore!: number | null;
  @ApiProperty({ type: [RevisionSnapshotEventDto] }) events!: RevisionSnapshotEventDto[];
}

export class MatchRevisionDto {
  @ApiProperty({ description: 'The match version this snapshot preserves' }) version!: number;
  @ApiProperty() reason!: string;
  @ApiProperty() changedById!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: RevisionSnapshotDto }) snapshot!: RevisionSnapshotDto;
}

export class MatchRevisionsDto {
  @ApiProperty({ type: [MatchRevisionDto] }) items!: MatchRevisionDto[];
}

export class CaptainDto {
  @ApiProperty() teamId!: string;
  @ApiProperty({ nullable: true, type: String }) captainId!: string | null;
}

// stats / history

export class RoleGamesDto {
  @ApiProperty({ description: 'Distinct events with a confirmed result' }) games!: number;
}

export class UserStatsDto {
  @ApiProperty() userId!: string;
  @ApiProperty({
    description: 'True ⇒ the owner hid this section from the viewer; NO numbers are returned',
  })
  hidden!: boolean;
  @ApiPropertyOptional({ enum: ['PLAYER', 'ORGANISER', 'REFEREE'] })
  primaryRole?: 'PLAYER' | 'ORGANISER' | 'REFEREE';
  @ApiPropertyOptional({ description: 'Distinct confirmed matches played' }) games?: number;
  @ApiPropertyOptional() goals?: number;
  @ApiPropertyOptional() assists?: number;
  @ApiPropertyOptional() yellowCards?: number;
  @ApiPropertyOptional() redCards?: number;
  @ApiPropertyOptional() mvps?: number;
  @ApiPropertyOptional() trophies?: number;
  @ApiPropertyOptional({ description: 'Active tournaments the user is in a confirmed squad of' })
  tournaments?: number;
  @ApiPropertyOptional({ type: RoleGamesDto }) organiser?: RoleGamesDto;
  @ApiPropertyOptional({ type: RoleGamesDto }) referee?: RoleGamesDto;
}

export class HistoryContributionDto {
  @ApiProperty() goals!: number;
  @ApiProperty() assists!: number;
  @ApiProperty() ownGoals!: number;
  @ApiProperty() yellowCards!: number;
  @ApiProperty() redCards!: number;
  @ApiProperty() mvp!: boolean;
}

export class HistoryItemDto {
  @ApiProperty() matchId!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ nullable: true, type: String }) tournamentId!: string | null;
  @ApiProperty() playedAt!: string;
  @ApiProperty() eventKind!: string;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) venueName!: string | null;
  @ApiProperty({ nullable: true, type: String }) homeTeamName!: string | null;
  @ApiProperty({ nullable: true, type: String }) awayTeamName!: string | null;
  @ApiProperty({ nullable: true, type: Number }) homeScore!: number | null;
  @ApiProperty({ nullable: true, type: Number }) awayScore!: number | null;
  @ApiProperty({ enum: ['HOME', 'AWAY'], nullable: true, type: String })
  side!: 'HOME' | 'AWAY' | null;
  @ApiProperty({ enum: ['WIN', 'DRAW', 'LOSS'], nullable: true, type: String })
  outcome!: 'WIN' | 'DRAW' | 'LOSS' | null;
  @ApiProperty({ type: HistoryContributionDto }) contribution!: HistoryContributionDto;
}

export class UserHistoryDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ description: 'True ⇒ hidden by the owner; items is then absent' })
  hidden!: boolean;
  @ApiPropertyOptional({ type: [HistoryItemDto] }) items?: HistoryItemDto[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor?: string | null;
}
