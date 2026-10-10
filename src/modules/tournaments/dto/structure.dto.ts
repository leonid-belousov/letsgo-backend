import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FixtureStatus, StageKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BookingProblemDto } from './bookings.dto';
import { ClubRefDto } from './entries.dto';

// ───────────── requests ─────────────

export class CreateStageDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @ApiProperty({ enum: StageKind }) @IsEnum(StageKind) kind!: StageKind;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'GROUP {groups:["A","B"], rounds:1|2} - LEAGUE {rounds} - KNOCKOUT {pairs:[[seedRef, seedRef|null]] | participants:[seedRef], thirdPlace} - ' +
      'CUSTOM {}. seedRef = {entryId} | {stage:<stage index>, group, rank}. Common: points {win,draw,loss} (default 3/1/0), ' +
      'tiebreakers (default [points, goalDifference, goalsFor]; head-to-head / fair play / lots are not implemented - OPEN), ' +
      'matchMinutes, changeoverMinutes, reserveMinutes, minRestMinutes.',
  })
  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateStageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class DrawDto {
  @ApiProperty({ enum: ['MANUAL', 'RANDOM'] }) @IsIn(['MANUAL', 'RANDOM']) mode!:
    'MANUAL' | 'RANDOM';
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: 'MANUAL: group label -> entry ids (each accepted club exactly once)',
  })
  @IsOptional()
  @IsObject()
  assignments?: Record<string, string[]>;
  @ApiPropertyOptional({
    description: 'RANDOM: seed for a reproducible draw (recorded); generated when omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  seed?: string;
  @ApiPropertyOptional({
    type: [String],
    description: 'RANDOM: restrict to these accepted entries (default: all accepted)',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  entryIds?: string[];
}

export class CreateFixtureDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() homeEntryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() awayEntryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) homePlaceholder?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) awayPlaceholder?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(1000) round?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) groupLabel?: string;
}

export class FixtureListQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() stageId?: string;
  @ApiPropertyOptional({ enum: FixtureStatus })
  @IsOptional()
  @IsEnum(FixtureStatus)
  status?: FixtureStatus;
  @ApiPropertyOptional({ description: 'Fixtures of this club' })
  @IsOptional()
  @IsUUID()
  clubId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

export class ShootoutDto {
  @ApiProperty() @IsInt() @Min(0) @Max(99) home!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(99) away!: number;
}

export class RecordResultDto {
  @ApiProperty() @IsInt() @Min(0) @Max(99) homeScore!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(99) awayScore!: number;
  @ApiPropertyOptional({
    type: ShootoutDto,
    description:
      'Knockout ties must be decided: penalties are stored separately from playing-time goals',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShootoutDto)
  shootout?: ShootoutDto;
}

export class CorrectResultDto extends RecordResultDto {
  @ApiProperty({ description: 'Recorded in the audit log with the old and new score' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
  @ApiPropertyOptional({
    enum: ['KEEP_ASSIGNMENTS', 'REASSIGN_UNPLAYED'],
    description:
      'Required when the correction changes who a dependent fixture should have: KEEP leaves already-resolved sides untouched; ' +
      'REASSIGN re-resolves dependents that have not been played. Played fixtures are never rebuilt.',
  })
  @IsOptional()
  @IsIn(['KEEP_ASSIGNMENTS', 'REASSIGN_UNPLAYED'])
  decision?: 'KEEP_ASSIGNMENTS' | 'REASSIGN_UNPLAYED';
}

export class FixtureStatusDto {
  @ApiProperty({ enum: ['SCHEDULED', 'LIVE', 'POSTPONED', 'CANCELLED'] })
  @IsIn(['SCHEDULED', 'LIVE', 'POSTPONED', 'CANCELLED'])
  status!: 'SCHEDULED' | 'LIVE' | 'POSTPONED' | 'CANCELLED';
}

export class TieResolutionDto {
  @ApiProperty({ description: 'Group label (empty string for a league)' })
  @IsString()
  @MaxLength(20)
  group!: string;
  @ApiProperty({
    type: [String],
    description:
      'The tied clubs in the order the organiser decides (recorded with author and time)',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(64)
  @IsUUID('all', { each: true })
  entryIds!: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class PitchWindowDto {
  @ApiProperty() @IsUUID() pitchId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) @Type(() => Date) @IsDate() startsAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) @Type(() => Date) @IsDate() endsAt!: Date;
}

export class ScheduleParamsDto {
  @ApiProperty({
    type: [PitchWindowDto],
    description: 'Availability windows per pitch (the rented intervals)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PitchWindowDto)
  windows!: PitchWindowDto[];
  @ApiProperty({ description: 'Match length - independent of the rental length' })
  @IsInt()
  @Min(1)
  @Max(240)
  matchMinutes!: number;
  @ApiProperty({ description: 'Minimum gap between two matches on the same pitch' })
  @IsInt()
  @Min(0)
  @Max(240)
  changeoverMinutes!: number;
  @ApiProperty({
    description:
      'Minimum rest per CLUB (end of one match to start of its next). Never shrunk silently.',
  })
  @IsInt()
  @Min(0)
  @Max(1440)
  minRestMinutes!: number;
  @ApiPropertyOptional({
    description: 'Extra pitch minutes kept after every playoff match (penalties, delays)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  playoffReserveMinutes?: number;
  @ApiPropertyOptional({ type: [String], description: 'Only these stages (default: all)' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  stageIds?: string[];
  @ApiPropertyOptional({
    description:
      'Also move fixtures that already have a slot (never played/live ones). Default false: only unscheduled fixtures are placed.',
  })
  @IsOptional()
  @IsBoolean()
  reschedule?: boolean;
  @ApiPropertyOptional({
    description: 'Current schedule version the client saw; mismatch = 409 VERSION_CHANGED',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class ApplyScheduleDto extends ScheduleParamsDto {
  @ApiPropertyOptional({
    description:
      'Publish the applied slots (first publication); changes to an already published schedule always publish a new version',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class MoveFixtureDto {
  @ApiProperty() @IsUUID() pitchId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) @Type(() => Date) @IsDate() startsAt!: Date;
  @ApiPropertyOptional({ description: 'Defaults to the fixture length' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;
  @ApiPropertyOptional({
    description: 'Minimum rest to verify (default: the largest stage minRestMinutes, else 0)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  minRestMinutes?: number;
  @ApiPropertyOptional({
    description: 'Explicit organiser decision to accept a rest below the minimum',
  })
  @IsOptional()
  @IsBoolean()
  allowShortRest?: boolean;
}

// ───────────── responses ─────────────

export class StageDto {
  @ApiProperty() id!: string;
  @ApiProperty() index!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: StageKind }) kind!: StageKind;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: Record<string, unknown>;
  @ApiProperty() fixtureCount!: number;
  @ApiProperty() playedCount!: number;
}

export class StageProblemDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() stageIndex?: number;
}

export class StructureCheckDto {
  @ApiProperty({ type: [StageProblemDto] }) problems!: StageProblemDto[];
}

export class GenerateResultDto {
  @ApiProperty() created!: number;
  @ApiProperty({ description: 'Free passes (not counted as played matches)' }) byes!: number;
  @ApiProperty({ type: StageDto }) stage!: StageDto;
}

export class FixtureSideDto {
  @ApiProperty({ nullable: true, type: String }) entryId!: string | null;
  @ApiProperty({ type: ClubRefDto, nullable: true }) club!: ClubRefDto | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Machine placeholder (RANK:<stage>:<group>:<rank>, W:/L:<fixture id>)',
  })
  placeholder!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Human placeholder, e.g. "A1" or "Winner of Semi-final 1"',
  })
  placeholderLabel!: string | null;
}

export class FixtureDto {
  @ApiProperty() id!: string;
  @ApiProperty() stageId!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ enum: StageKind }) stageKind!: StageKind;
  @ApiProperty() round!: number;
  @ApiProperty({ nullable: true, type: String, description: 'Group label for GROUP stages' })
  groupLabel!: string | null;
  @ApiProperty({ description: 'e.g. "Group A - round 2", "Semi-final 1", "Final", "Third place"' })
  label!: string;
  @ApiProperty({ type: FixtureSideDto }) home!: FixtureSideDto;
  @ApiProperty({ type: FixtureSideDto }) away!: FixtureSideDto;
  @ApiProperty({ nullable: true, type: String }) pitchId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startsAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) endsAt!: string | null;
  @ApiProperty({
    description: '0 = unpublished draft slot; >=1 = published in that schedule version',
  })
  scheduleVersion!: number;
  @ApiProperty({ enum: FixtureStatus }) status!: FixtureStatus;
  @ApiProperty({ nullable: true, type: Number }) homeScore!: number | null;
  @ApiProperty({ nullable: true, type: Number }) awayScore!: number | null;
  @ApiProperty({ type: ShootoutDto, nullable: true }) shootout!: ShootoutDto | null;
  @ApiProperty({ nullable: true, type: String }) winnerEntryId!: string | null;
}

export class FixtureListDto {
  @ApiProperty({ type: [FixtureDto] }) items!: FixtureDto[];
}

export class StandingRowDto {
  @ApiProperty() entryId!: string;
  @ApiProperty({ type: ClubRefDto, nullable: true }) club!: ClubRefDto | null;
  @ApiProperty() played!: number;
  @ApiProperty() won!: number;
  @ApiProperty() drawn!: number;
  @ApiProperty() lost!: number;
  @ApiProperty() goalsFor!: number;
  @ApiProperty() goalsAgainst!: number;
  @ApiProperty() goalDifference!: number;
  @ApiProperty() points!: number;
  @ApiProperty() rank!: number;
  @ApiProperty({
    description:
      'Equal on every configured criterion with another club: unresolved until the organiser decides',
  })
  tied!: boolean;
}

export class StandingsGroupDto {
  @ApiProperty({ description: 'Empty string for a league' }) label!: string;
  @ApiProperty({ description: 'Every non-cancelled fixture of the group is finished' })
  confirmed!: boolean;
  @ApiProperty() hasUnresolvedTie!: boolean;
  @ApiProperty({ type: [StandingRowDto] }) rows!: StandingRowDto[];
}

export class StandingsStageDto {
  @ApiProperty() stageId!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ enum: StageKind }) kind!: StageKind;
  @ApiProperty({ type: [StandingsGroupDto] }) groups!: StandingsGroupDto[];
}

export class StandingsDto {
  @ApiProperty({ type: [StandingsStageDto] }) stages!: StandingsStageDto[];
}

export class BracketRoundDto {
  @ApiProperty() round!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [FixtureDto] }) fixtures!: FixtureDto[];
}

export class BracketStageDto {
  @ApiProperty() stageId!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ type: [BracketRoundDto] }) rounds!: BracketRoundDto[];
}

export class BracketsDto {
  @ApiProperty({ type: [BracketStageDto] }) stages!: BracketStageDto[];
}

export class AffectedFixtureDto {
  @ApiProperty() fixtureId!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['home', 'away'] }) side!: string;
  @ApiProperty({ nullable: true, type: String }) currentEntryId!: string | null;
  @ApiProperty({ nullable: true, type: String }) newEntryId!: string | null;
  @ApiProperty({ enum: FixtureStatus }) status!: FixtureStatus;
  @ApiProperty({ description: 'Already played/live: never rebuilt' }) locked!: boolean;
}

export class ImpactDto {
  @ApiProperty({ type: [AffectedFixtureDto] }) affected!: AffectedFixtureDto[];
}

export class ClubRestDto {
  @ApiProperty() entryId!: string;
  @ApiProperty({ type: ClubRefDto, nullable: true }) club!: ClubRefDto | null;
  @ApiProperty() matches!: number;
  @ApiProperty({ nullable: true, type: Number }) minRestMinutes!: number | null;
}

export class ScheduleConflictDto {
  @ApiProperty({ enum: ['PITCH_OVERLAP', 'CLUB_OVERLAP', 'REST_TOO_SHORT'] }) type!: string;
  @ApiProperty({ type: [String] }) fixtureIds!: string[];
  @ApiPropertyOptional() entryId?: string;
  @ApiPropertyOptional() pitchId?: string;
  @ApiPropertyOptional() restMinutes?: number;
  @ApiProperty() message!: string;
}

export class ScheduleAnalysisDto {
  @ApiProperty({ type: [ClubRestDto] }) clubs!: ClubRestDto[];
  @ApiProperty({ nullable: true, type: Number, description: 'Actual smallest rest of any club' })
  minRestMinutes!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Largest minus smallest per-club minimum: unequal rest is shown, not hidden',
  })
  restSpreadMinutes!: number | null;
  @ApiProperty({ type: [ScheduleConflictDto] }) conflicts!: ScheduleConflictDto[];
}

export class ProposedSlotDto {
  @ApiProperty() fixtureId!: string;
  @ApiProperty() pitchId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
  @ApiProperty({ description: 'Differs from the currently saved slot' }) changed!: boolean;
  @ApiProperty({
    description: 'The fixture is already published: clubs will be notified of the change',
  })
  published!: boolean;
}

export class UnscheduledDto {
  @ApiProperty() fixtureId!: string;
  @ApiProperty({ enum: ['NO_SLOT_IN_WINDOWS', 'DEPENDENCY_UNSCHEDULED'] }) reason!: string;
  @ApiProperty() detail!: string;
}

export class SchedulePreviewDto {
  @ApiProperty({ description: 'Saved schedule version (0 = nothing published)' })
  scheduleVersion!: number;
  @ApiProperty({ type: [ProposedSlotDto] }) slots!: ProposedSlotDto[];
  @ApiProperty({ type: [UnscheduledDto] }) unscheduled!: UnscheduledDto[];
  @ApiProperty({ type: ScheduleAnalysisDto }) analysis!: ScheduleAnalysisDto;
  @ApiProperty({ type: [String], description: 'Entry ids whose PUBLISHED fixtures would move' })
  affectedEntryIds!: string[];
  @ApiProperty({
    type: [BookingProblemDto],
    description:
      'Blocking rental problems: WINDOW_UNCONFIRMED, OUTSIDE_BOOKED_WINDOW, WINDOW_LOST, RESOURCE_UNAVAILABLE',
  })
  bookingProblems!: BookingProblemDto[];
  @ApiProperty({
    type: [BookingProblemDto],
    description: 'Non-blocking: UNBOOKED (free pitch without an attached booking)',
  })
  warnings!: BookingProblemDto[];
  @ApiProperty({ description: 'Nothing was saved' }) saved!: boolean;
}

export class ScheduleApplyResultDto extends SchedulePreviewDto {
  @ApiProperty({ description: 'Fixtures whose slot changed' }) changedCount!: number;
  @ApiProperty({ description: 'Version now current for published slots' })
  newScheduleVersion!: number;
  @ApiProperty() notified!: number;
}

export class ScheduleReportDto {
  @ApiProperty() scheduleVersion!: number;
  @ApiProperty() scheduledFixtures!: number;
  @ApiProperty() unscheduledFixtures!: number;
  @ApiProperty({ type: ScheduleAnalysisDto }) analysis!: ScheduleAnalysisDto;
  @ApiProperty({
    type: [BookingProblemDto],
    description: 'Lost / unconfirmed / foreign-occupied rentals surface here',
  })
  bookingProblems!: BookingProblemDto[];
  @ApiProperty({ type: [BookingProblemDto] }) warnings!: BookingProblemDto[];
}
