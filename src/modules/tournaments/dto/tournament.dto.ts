import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AgeBand,
  EntryStatus,
  FeeMode,
  ObligationKind,
  ObligationStatus,
  TournamentDuration,
  TournamentStatus,
} from '@prisma/client';
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
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQuery } from '../../../common/pagination/cursor-page';
import { PersonSummaryDto } from '../../users/person-summary';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Module permissions an assistant may receive (never `tournament.manage`). */
export const ASSISTANT_PERMISSIONS = [
  'tournament.applications',
  'tournament.schedule',
  'tournament.protocols',
  'tournament.cash',
  'tournament.sponsors',
] as const;

// ───────────── requests ─────────────

export class CreateTournamentDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) city!: string;
  @ApiProperty({
    example: 'Asia/Tbilisi',
    description: 'IANA timezone; dates and age are evaluated in it',
  })
  @IsString()
  @MaxLength(64)
  timezone!: string;
  @ApiProperty({ enum: TournamentDuration })
  @IsEnum(TournamentDuration)
  duration!: TournamentDuration;
  @ApiProperty({ example: '2026-09-27', description: 'Calendar date in the tournament timezone' })
  @Matches(DATE_RE)
  startsOn!: string;
  @ApiPropertyOptional({ example: '2026-09-27', description: 'Required for MULTI_DAY and SEASON' })
  @IsOptional()
  @Matches(DATE_RE)
  endsOn?: string;
  @ApiProperty({
    minimum: 5,
    maximum: 11,
    description: 'Players per side on the pitch (5v5 ... 11v11)',
  })
  @IsInt()
  @Min(5)
  @Max(11)
  formatPlayers!: number;
  @ApiPropertyOptional({ enum: AgeBand, default: 'NONE', description: 'Only one age band' })
  @IsOptional()
  @IsEnum(AgeBand)
  ageBand?: AgeBand;
  @ApiPropertyOptional({
    description: 'Younger players may REQUEST an exception (organiser decides each one)',
  })
  @IsOptional()
  @IsBoolean()
  allowYounger?: boolean;
  @ApiPropertyOptional({ enum: FeeMode, default: 'FREE' })
  @IsOptional()
  @IsEnum(FeeMode)
  feeMode?: FeeMode;
  @ApiPropertyOptional({ description: 'Minor units per club or per player, depending on feeMode' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  feeMinor?: number;
  @ApiPropertyOptional({ default: 'GEL' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(2) @Max(512) minClubs?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(512) maxClubs?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) minPlayersPerClub?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) maxPlayersPerClub?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isPublic?: boolean;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() waitlistOpen?: boolean;
  @ApiPropertyOptional({ description: 'READY photo you own' })
  @IsOptional()
  @IsUUID()
  logoMediaId?: string;
}

export class UpdateTournamentDto {
  @ApiProperty({ description: 'Optimistic concurrency: 409 VERSION_CHANGED when stale' })
  @IsInt()
  @Min(1)
  version!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @ApiPropertyOptional({ enum: TournamentDuration })
  @IsOptional()
  @IsEnum(TournamentDuration)
  duration?: TournamentDuration;
  @ApiPropertyOptional() @IsOptional() @Matches(DATE_RE) startsOn?: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(DATE_RE)
  endsOn?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(11) formatPlayers?: number;
  @ApiPropertyOptional({ enum: AgeBand }) @IsOptional() @IsEnum(AgeBand) ageBand?: AgeBand;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowYounger?: boolean;
  @ApiPropertyOptional({ enum: FeeMode }) @IsOptional() @IsEnum(FeeMode) feeMode?: FeeMode;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100_000_000) feeMinor?: number;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(512)
  minClubs?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(512)
  maxClubs?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  minPlayersPerClub?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPlayersPerClub?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() waitlistOpen?: boolean;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUUID()
  logoMediaId?: string | null;
}

export class TournamentListQuery extends PageQuery {
  @ApiPropertyOptional({
    enum: ['UPCOMING', 'ANY'],
    default: 'UPCOMING',
    description: 'UPCOMING excludes FINISHED and CANCELLED; ANY ("Any time") includes them',
  })
  @IsOptional()
  @IsIn(['UPCOMING', 'ANY'])
  when?: 'UPCOMING' | 'ANY';
  @ApiPropertyOptional({
    description: 'Comma-separated statuses (explicit status filter, overrides `when`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional({ description: 'Comma-separated formats, e.g. 5,7' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  formats?: string;
  @ApiPropertyOptional({ enum: AgeBand }) @IsOptional() @IsEnum(AgeBand) ageBand?: AgeBand;
  @ApiPropertyOptional({ example: '2026-09-01' }) @IsOptional() @Matches(DATE_RE) from?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @Matches(DATE_RE) to?: string;
  @ApiPropertyOptional({
    description: 'true = tournaments I organise, assist, or take part in (incl. my drafts)',
  })
  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  mine?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() organiserId?: string;
}

export class PostponeTournamentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional({ example: '2026-10-04' }) @IsOptional() @Matches(DATE_RE) startsOn?: string;
  @ApiPropertyOptional({ example: '2026-10-04' }) @IsOptional() @Matches(DATE_RE) endsOn?: string;
}

export class CancelTournamentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class FinishTournamentDto {
  @ApiPropertyOptional({
    description: 'Finish although scheduled fixtures were never played (they stay unplayed)',
  })
  @IsOptional()
  @IsBoolean()
  confirmUnplayed?: boolean;
}

export class AppointAssistantDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty({ enum: ASSISTANT_PERMISSIONS, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ASSISTANT_PERMISSIONS.length)
  @ArrayUnique()
  @IsIn(ASSISTANT_PERMISSIONS as readonly string[], { each: true })
  permissions!: string[];
}

// ───────────── responses ─────────────

export class MainSponsorDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalUrl!: string | null;
}

/** Card label; never derived from the clock alone (LIVE only after a confirmed start). */
export const TOURNAMENT_LABELS = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'WAITLIST_OPEN',
  'REGISTRATION_CLOSED',
  'STARTS_SOON',
  'LIVE',
  'FINISHED',
  'POSTPONED',
  'CANCELLED',
] as const;
export type TournamentLabel = (typeof TOURNAMENT_LABELS)[number];

export class TournamentCardDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ enum: TournamentDuration }) duration!: TournamentDuration;
  @ApiProperty({ example: '2026-09-27' }) startsOn!: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-09-27' }) endsOn!: string | null;
  @ApiProperty() formatPlayers!: number;
  @ApiProperty({ enum: AgeBand }) ageBand!: AgeBand;
  @ApiProperty({ enum: FeeMode }) feeMode!: FeeMode;
  @ApiProperty() feeMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: TournamentStatus }) status!: TournamentStatus;
  @ApiProperty({ enum: TOURNAMENT_LABELS }) label!: TournamentLabel;
  @ApiProperty({ description: 'Accepted clubs only - not applications, not ready squads' })
  acceptedClubs!: number;
  @ApiProperty({ nullable: true, type: Number }) maxClubs!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'max - accepted - held by invitations; null without a maximum',
  })
  openSpots!: number | null;
  @ApiProperty() isPublic!: boolean;
  @ApiProperty({
    type: MainSponsorDto,
    nullable: true,
    description: 'Only the designated Main sponsor',
  })
  mainSponsor!: MainSponsorDto | null;
}

export class TournamentCapabilitiesDto {
  @ApiProperty() canEnter!: boolean;
  @ApiProperty({ description: 'Chief organiser (the only holder of tournament.manage)' })
  canManage!: boolean;
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canPublish!: boolean;
  @ApiProperty() canStart!: boolean;
  @ApiProperty() canCancel!: boolean;
  @ApiProperty() canAppointAssistants!: boolean;
  @ApiProperty() canManageApplications!: boolean;
  @ApiProperty() canSchedule!: boolean;
  @ApiProperty() canRecordResults!: boolean;
  @ApiProperty() canManageCash!: boolean;
  @ApiProperty() canEditSponsors!: boolean;
  @ApiProperty() canManageDocuments!: boolean;
}

export class ViewerEntryDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() clubId!: string;
  @ApiProperty() clubName!: string;
  @ApiProperty({ enum: EntryStatus }) status!: EntryStatus;
}

export class ViewerClubDto {
  @ApiProperty() clubId!: string;
  @ApiProperty() clubName!: string;
  @ApiProperty({ enum: EntryStatus, nullable: true, description: 'null = no entry yet' })
  entryStatus!: EntryStatus | null;
}

export class ViewerObligationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ObligationKind }) kind!: ObligationKind;
  @ApiProperty({ enum: ObligationStatus }) status!: ObligationStatus;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() paidMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) payerClubId!: string | null;
}

export class ViewerPlayerDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() clubId!: string;
  @ApiProperty({ enum: ['INVITED', 'CONFIRMED', 'DECLINED', 'REMOVED'] }) status!: string;
  @ApiProperty() isGuest!: boolean;
}

export class TournamentViewerDto {
  @ApiProperty({ type: [ViewerEntryDto], description: 'Entries of clubs I can act for' })
  entries!: ViewerEntryDto[];
  @ApiProperty({
    type: [ViewerClubDto],
    description: '"Enter with my club" chooser - only clubs I may act for',
  })
  enterableClubs!: ViewerClubDto[];
  @ApiProperty({ type: ViewerPlayerDto, nullable: true }) player!: ViewerPlayerDto | null;
  @ApiProperty({
    description: 'Mandatory documents assigned to my role that I have not accepted yet',
  })
  missingConsents!: number;
  @ApiProperty({ type: [ViewerObligationDto] }) obligations!: ViewerObligationDto[];
}

export class ManagerCountersDto {
  @ApiProperty({ description: 'APPLIED entries (open applications)' }) applications!: number;
  @ApiProperty({ description: 'INVITED entries (hold a spot)' }) invited!: number;
  @ApiProperty() waitlisted!: number;
  @ApiProperty({ description: 'Accepted clubs that are Ready' }) readyClubs!: number;
}

export class TournamentDto extends TournamentCardDto {
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ type: PersonSummaryDto }) organiser!: PersonSummaryDto;
  @ApiProperty({ nullable: true, type: Number }) minClubs!: number | null;
  @ApiProperty({ nullable: true, type: Number }) minPlayersPerClub!: number | null;
  @ApiProperty({ nullable: true, type: Number }) maxPlayersPerClub!: number | null;
  @ApiProperty() allowYounger!: boolean;
  @ApiProperty() waitlistOpen!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ description: 'Current published schedule version (0 = nothing published)' })
  scheduleVersion!: number;
  @ApiProperty({ type: ManagerCountersDto, nullable: true, description: 'Managers only' })
  counters!: ManagerCountersDto | null;
  @ApiProperty({
    type: TournamentViewerDto,
    nullable: true,
    description: 'null for anonymous viewers',
  })
  viewer!: TournamentViewerDto | null;
  @ApiProperty({ type: TournamentCapabilitiesDto }) capabilities!: TournamentCapabilitiesDto;
}

export class TournamentPageDto {
  @ApiProperty({ type: [TournamentCardDto] }) items!: TournamentCardDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ProblemDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() entryId?: string;
  @ApiPropertyOptional() clubId?: string;
  @ApiPropertyOptional() userId?: string;
  @ApiPropertyOptional() fixtureId?: string;
}

export class AssistantDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ type: PersonSummaryDto }) person!: PersonSummaryDto;
  @ApiProperty({ isArray: true, type: String }) permissions!: string[];
  @ApiProperty({ type: String, format: 'date-time' }) appointedAt!: string;
}

export class AssistantsDto {
  @ApiProperty({ type: [AssistantDto] }) items!: AssistantDto[];
  @ApiProperty() limit!: number;
}

export class RevokedDto {
  @ApiProperty() revoked!: number;
}
