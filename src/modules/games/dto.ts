import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AgeBand,
  ConfirmationSource,
  EventJoinMode,
  EventKind,
  EventStatus,
  InvitationStatus,
  ParticipationSource,
  ParticipationStatus,
  PitchStatus,
  type Participation,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';
import { PersonSummaryDto } from '../users/person-summary';

// ───────────── requests ─────────────

export class TeamInputDto {
  @ApiPropertyOptional({ example: 'Light shirts' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;
  @ApiPropertyOptional({ example: '#ffffff' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  colour?: string;
  @ApiPropertyOptional({ description: 'CLUB_V_CLUB: the club fielding this team' })
  @IsOptional()
  @IsUUID()
  clubId?: string;
}

export class AutoCancelDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'When the minimum is checked',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  checkAt?: Date;
}

export class CreateGameDto {
  @ApiProperty({ enum: EventKind }) @IsEnum(EventKind) kind!: EventKind;
  @ApiPropertyOptional({
    description: 'Required for CLUB_V_CLUB and TRAINING; optional for CASUAL',
  })
  @IsOptional()
  @IsUUID()
  clubId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() venueId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() pitchId?: string;
  @ApiPropertyOptional({
    description: 'Link an existing booking (pitch status is then derived from it)',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) title?: string;
  @ApiPropertyOptional({
    description: 'IANA zone; defaults to the venue timezone when a venue is chosen',
    example: 'Asia/Tbilisi',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
  @ApiProperty({ type: String, format: 'date-time', description: 'UTC instant' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) @Type(() => Date) @IsDate() endsAt!: Date;
  @ApiProperty({ minimum: 5, maximum: 11, description: 'Players per team on the pitch (5 = 5v5)' })
  @IsInt()
  @Min(5)
  @Max(11)
  formatPlayers!: number;
  @ApiPropertyOptional({ minimum: 2, maximum: 4, default: 2 })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(4)
  teamCount?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 8, default: 0, description: 'Substitutes per team' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8)
  substitutesPerTeam?: number;
  @ApiPropertyOptional({ description: 'TRAINING only: explicit participant limit (capacity)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxParticipants?: number;
  @ApiPropertyOptional({ description: 'Minimum confirmed players for the game to be played' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minConfirmed?: number;
  @ApiPropertyOptional({ description: 'Minor units per player; 0 = free', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceMinor?: number;
  @ApiPropertyOptional({ default: 'GEL' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional({
    enum: PitchStatus,
    description:
      'Only BOOKING_PENDING, COMMUNITY_PITCH or a manual PITCH_BOOKED; ignored when a booking is linked',
  })
  @IsOptional()
  @IsEnum(PitchStatus)
  pitchStatus?: PitchStatus;
  @ApiPropertyOptional({ enum: EventJoinMode, default: 'APPROVE_REQUESTS' })
  @IsOptional()
  @IsEnum(EventJoinMode)
  joinMode?: EventJoinMode;
  @ApiPropertyOptional({ enum: AgeBand, default: 'NONE' })
  @IsOptional()
  @IsEnum(AgeBand)
  ageBand?: AgeBand;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() allowYounger?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() refereeIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() videoIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() waterIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() bibsIncluded?: boolean;
  @ApiPropertyOptional({
    description: 'Assigned referee user (a service flag alone does not imply one)',
  })
  @IsOptional()
  @IsUUID()
  refereeUserId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() waitlistEnabled?: boolean;
  @ApiPropertyOptional({
    default: true,
    description: 'At the priority deadline, offer freed places to the remaining club players',
  })
  @IsOptional()
  @IsBoolean()
  autoNextWave?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() payCashEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ type: AutoCancelDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutoCancelDto)
  autoCancel?: AutoCancelDto;
  @ApiPropertyOptional({ type: [TeamInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => TeamInputDto)
  teams?: TeamInputDto[];
  @ApiPropertyOptional({ default: false, description: 'Publish immediately (otherwise DRAFT)' })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdateGameDto {
  @ApiProperty({ description: 'Current version; stale → 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;
  @ApiPropertyOptional({ minimum: 5, maximum: 11, description: 'Only while no match exists' })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(11)
  formatPlayers?: number;
  @ApiPropertyOptional({
    minimum: 2,
    maximum: 4,
    description:
      'Increase adds teams; decrease only removes EMPTY teams (else 409 TEAM_REDISTRIBUTION_UNDEFINED)',
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(4)
  teamCount?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8)
  substitutesPerTeam?: number;
  @ApiPropertyOptional({ description: 'TRAINING only' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxParticipants?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) title?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) minConfirmed?: number;
  @ApiPropertyOptional({ description: 'Minor units. Existing obligations are NOT rewritten.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceMinor?: number;
  @ApiPropertyOptional({ enum: EventJoinMode })
  @IsOptional()
  @IsEnum(EventJoinMode)
  joinMode?: EventJoinMode;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() waitlistEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoNextWave?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() payCashEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() refereeIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() videoIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() waterIncluded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() bibsIncluded?: boolean;
  @ApiPropertyOptional({ enum: PitchStatus })
  @IsOptional()
  @IsEnum(PitchStatus)
  pitchStatus?: PitchStatus;
  @ApiPropertyOptional({ type: AutoCancelDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutoCancelDto)
  autoCancel?: AutoCancelDto;
}

export class CancelGameDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class JoinDto {
  @ApiPropertyOptional({ description: 'Preferred team; required for CLUB_V_CLUB' })
  @IsOptional()
  @IsUUID()
  teamId?: string;
}

export class MoveDto {
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsUUID() teamId?:
    string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isSubstitute?: boolean;
}

export class CreateInvitationsDto {
  @ApiProperty({ type: [String], description: 'Recipients — several guests and players at once' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  inviteeIds!: string[];
  @ApiPropertyOptional({
    description: 'Priority ⇒ holds a place until `respondBy`; ordinary ⇒ holds nothing',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  priority?: boolean;
  @ApiPropertyOptional({
    description: 'Guest (temporary participant); independent from priority',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isGuest?: boolean;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Reply-by deadline (required for priority)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  respondBy?: Date;
}

export class ExtendInvitationDto {
  @ApiProperty({ type: String, format: 'date-time' }) @Type(() => Date) @IsDate() respondBy!: Date;
}

export class GameListQuery extends PageQuery {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
  @ApiPropertyOptional({ description: 'Comma-separated formats, e.g. 5,7 (OR inside the group)' })
  @IsOptional()
  @IsString()
  formats?: string;
  @ApiPropertyOptional({ description: 'Comma-separated kinds (OR)' })
  @IsOptional()
  @IsString()
  kinds?: string;
  @ApiPropertyOptional({
    enum: ['ANY', 'OPEN', 'OPEN_OR_WAITLIST'],
    description: 'One availability choice (no contradictory toggles)',
  })
  @IsOptional()
  @IsString()
  availability?: 'ANY' | 'OPEN' | 'OPEN_OR_WAITLIST';
  @ApiPropertyOptional({ description: 'Minor units (per player)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMin?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMax?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() freeOnly?: string;
  @ApiPropertyOptional({ enum: AgeBand, description: 'Filter by the event’s declared age band' })
  @IsOptional()
  @IsEnum(AgeBand)
  ageBand?: AgeBand;
  @ApiPropertyOptional() @IsOptional() @IsString() referee?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() video?: string;
  @ApiPropertyOptional({ description: 'Only games with pitch status PITCH_BOOKED' })
  @IsOptional()
  @IsString()
  pitchBookedOnly?: string;
  @ApiPropertyOptional({
    description: 'Only venue/system-confirmed bookings (excludes manual marks)',
  })
  @IsOptional()
  @IsString()
  venueConfirmedOnly?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() organiserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() clubId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() venueId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() pitchId?: string;
  @ApiPropertyOptional({ description: 'At least one confirmed player I follow' })
  @IsOptional()
  @IsString()
  playersIFollow?: string;
  @ApiPropertyOptional({ description: 'Venue city' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;
  @ApiPropertyOptional({ description: 'Comma-separated pitch surfaces (OR), e.g. ARTIFICIAL,NATURAL' })
  @IsOptional()
  @IsString()
  surfaces?: string;
  @ApiPropertyOptional({ description: 'Comma-separated pitch settings (OR), e.g. INDOOR,OUTDOOR' })
  @IsOptional()
  @IsString()
  settings?: string;
  @ApiPropertyOptional({ description: 'Comma-separated pitch amenities; any selected amenity matches (OR)' })
  @IsOptional()
  @IsString()
  amenities?: string;
  @ApiPropertyOptional({ minimum: 0, description: 'Minimum game duration in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  durationMinMinutes?: number;
  @ApiPropertyOptional({ minimum: 0, description: 'Maximum game duration in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  durationMaxMinutes?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Minimum organiser rating' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5)
  minOrganiserRating?: number;
  @ApiPropertyOptional({ description: 'Viewer position for NEAREST (degrees)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;
  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
  @ApiPropertyOptional({ minimum: 0, description: 'Distance radius in kilometres; requires lat and lng' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  radiusKm?: number;
  @ApiPropertyOptional({
    enum: [
      'RECOMMENDED',
      'STARTING_SOON',
      'NEAREST',
      'PRICE_LOW_HIGH',
      'ORGANISER_RATING',
      'RECENTLY_ADDED',
    ],
    description: 'Recommended = starting soon until the ranking algorithm is decided (OPEN #2)',
  })
  @IsOptional()
  @IsString()
  sort?:
    | 'RECOMMENDED'
    | 'STARTING_SOON'
    | 'NEAREST'
    | 'PRICE_LOW_HIGH'
    | 'ORGANISER_RATING'
    | 'RECENTLY_ADDED';
}

// ───────────── responses ─────────────

export class SeatsDto {
  @ApiProperty() capacity!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty({
    description: 'Public free places = capacity − confirmed − reserved (holds/offers)',
  })
  spotsLeft!: number;
  @ApiProperty() waitlisted!: number;
}

export class ParticipationDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ParticipationStatus }) status!: ParticipationStatus;
  @ApiProperty({ nullable: true, type: String }) teamId!: string | null;
  @ApiProperty() isSubstitute!: boolean;
  @ApiProperty() isGuest!: boolean;
  @ApiProperty({ enum: ParticipationSource }) source!: ParticipationSource;
  @ApiProperty() ageExceptionRequested!: boolean;
  @ApiProperty({ nullable: true, type: Number, description: '1-based; only while WAITLISTED' })
  waitlistPosition!: number | null;

  static from(p: Participation, waitlistPosition: number | null): ParticipationDto {
    return {
      id: p.id,
      eventId: p.eventId,
      userId: p.userId,
      status: p.status,
      teamId: p.teamId,
      isSubstitute: p.isSubstitute,
      isGuest: p.isGuest,
      source: p.source,
      ageExceptionRequested: p.ageExceptionRequested,
      waitlistPosition,
    };
  }
}

export class GameCapabilitiesDto {
  @ApiProperty() canJoin!: boolean;
  @ApiProperty() canRequestToJoin!: boolean;
  @ApiProperty() canJoinWaitlist!: boolean;
  @ApiProperty() canLeave!: boolean;
  @ApiProperty() canConfirmInvitation!: boolean;
  @ApiProperty() canDeclineInvitation!: boolean;
  @ApiProperty() canAcceptOffer!: boolean;
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canPublish!: boolean;
  @ApiProperty() canCancel!: boolean;
  @ApiProperty() canInvite!: boolean;
  @ApiProperty() canApprove!: boolean;
  @ApiProperty() canManageSquad!: boolean;
  @ApiProperty() canViewMoney!: boolean;
  @ApiProperty({ description: 'Viewer may record Cash received for this game' })
  canConfirmCash!: boolean;
  @ApiProperty() canOpenChat!: boolean;
  @ApiProperty({ description: 'Attach a valid replacement booking (clears venue-needs-attention)' })
  canAttachBooking!: boolean;
  @ApiProperty({
    description:
      'Viewer’s own eligibility: ELIGIBLE | EXCEPTION_REQUIRED | NOT_ALLOWED | UNKNOWN_DOB',
  })
  ageEligibility!: string;
}

export class ViewerInvitationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: InvitationStatus }) status!: InvitationStatus;
  @ApiProperty() priority!: boolean;
  @ApiProperty() isGuest!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) respondBy!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Priority invitation: "Your place is held until …"',
  })
  heldUntil!: string | null;
}

export class ViewerStateDto {
  @ApiProperty({ nullable: true, type: ParticipationDto }) participation!: ParticipationDto | null;
  @ApiProperty({ nullable: true, type: ViewerInvitationDto })
  invitation!: ViewerInvitationDto | null;
  @ApiProperty({ nullable: true, type: String }) offerId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) offerExpiresAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) obligationId!: string | null;
}

export class EntityRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) handle?: string | null;
}

export class OrganiserDto extends PersonSummaryDto {
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Organiser rating; null when unrated (no zero, no placeholder)',
  })
  rating!: number | null;
  @ApiProperty() ratingCount!: number;
}

export class TeamDto {
  @ApiProperty() id!: string;
  @ApiProperty() index!: number;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String }) colour!: string | null;
  @ApiProperty({ nullable: true, type: String }) captainId!: string | null;
  @ApiProperty({ nullable: true, type: String }) clubId!: string | null;
}

export class GameDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: EventKind }) kind!: EventKind;
  @ApiProperty({ enum: EventStatus }) status!: EventStatus;
  @ApiProperty({ type: OrganiserDto }) organiser!: OrganiserDto;
  @ApiProperty({ nullable: true, type: EntityRefDto }) club!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: EntityRefDto }) venue!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: EntityRefDto }) pitch!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: String }) bookingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
  @ApiProperty() formatPlayers!: number;
  @ApiProperty() teamCount!: number;
  @ApiProperty() substitutesPerTeam!: number;
  @ApiProperty({ nullable: true, type: Number }) minConfirmed!: number | null;
  @ApiProperty({ description: 'Minor units per player' }) priceMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PitchStatus, nullable: true }) pitchStatus!: PitchStatus | null;
  @ApiProperty({ enum: ConfirmationSource, nullable: true })
  pitchStatusSource!: ConfirmationSource | null;
  @ApiProperty({ enum: EventJoinMode }) joinMode!: EventJoinMode;
  @ApiProperty({ enum: AgeBand }) ageBand!: AgeBand;
  @ApiProperty() allowYounger!: boolean;
  @ApiProperty() refereeIncluded!: boolean;
  @ApiProperty() videoIncluded!: boolean;
  @ApiProperty() waterIncluded!: boolean;
  @ApiProperty() bibsIncluded!: boolean;
  @ApiProperty() refereeAssigned!: boolean;
  @ApiProperty() waitlistEnabled!: boolean;
  @ApiProperty() payCashEnabled!: boolean;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() autoCancelEnabled!: boolean;
  @ApiProperty() autoNextWave!: boolean;
  @ApiProperty({
    description: 'The linked booking was lost: the game stays, the venue must be fixed',
  })
  venueNeedsAttention!: boolean;
  @ApiProperty({ nullable: true, type: String }) venueAttentionReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  venueAttentionAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) autoCancelCheckAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ type: SeatsDto }) seats!: SeatsDto;
  @ApiProperty({ type: [TeamDto] }) teams!: TeamDto[];
  @ApiProperty() version!: number;
  @ApiProperty({ type: ViewerStateDto }) viewer!: ViewerStateDto;
  @ApiProperty({ type: GameCapabilitiesDto }) capabilities!: GameCapabilitiesDto;
}

export class PlayerDto {
  @ApiProperty({ type: PersonSummaryDto }) player!: PersonSummaryDto;
  @ApiProperty() participationId!: string;
  @ApiProperty({ nullable: true, type: String }) teamId!: string | null;
  @ApiProperty() isSubstitute!: boolean;
  @ApiProperty() isGuest!: boolean;
}

export class ManagedEntryDto extends PlayerDto {
  @ApiProperty({ enum: ParticipationStatus }) status!: ParticipationStatus;
  @ApiProperty() ageExceptionRequested!: boolean;
  @ApiProperty({ nullable: true, type: Number }) waitlistPosition!: number | null;
}

export class PlayersDto {
  @ApiProperty({ type: [PlayerDto], description: 'Confirmed players only' })
  confirmed!: PlayerDto[];
  @ApiProperty() waitlistedCount!: number;
  @ApiProperty({
    type: [ManagedEntryDto],
    description: 'Pending requests and the waitlist — only for squad managers',
  })
  managed!: ManagedEntryDto[];
}

export class InvitationDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ type: PersonSummaryDto }) invitee!: PersonSummaryDto;
  @ApiProperty({ type: PersonSummaryDto }) invitedBy!: PersonSummaryDto;
  @ApiProperty({ enum: InvitationStatus }) status!: InvitationStatus;
  @ApiProperty() priority!: boolean;
  @ApiProperty() isGuest!: boolean;
  @ApiProperty() waveNumber!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) respondBy!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) heldUntil!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) respondedAt!: string | null;
}

export class GameJoinStateDto {
  @ApiProperty() canJoin!: boolean;
  @ApiProperty() canRequestToJoin!: boolean;
  @ApiProperty() canJoinWaitlist!: boolean;
}

export class GameSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: EventKind }) kind!: EventKind;
  @ApiProperty({ enum: EventStatus }) status!: EventStatus;
  @ApiProperty({ type: OrganiserDto }) organiser!: OrganiserDto;
  @ApiProperty({ nullable: true, type: EntityRefDto }) club!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: EntityRefDto }) venue!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: EntityRefDto }) pitch!: EntityRefDto | null;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
  @ApiProperty() formatPlayers!: number;
  @ApiProperty({ description: 'Minor units per player' }) priceMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PitchStatus, nullable: true }) pitchStatus!: PitchStatus | null;
  @ApiProperty({ enum: AgeBand }) ageBand!: AgeBand;
  @ApiProperty() refereeIncluded!: boolean;
  @ApiProperty() videoIncluded!: boolean;
  @ApiProperty() waitlistEnabled!: boolean;
  @ApiProperty({ type: SeatsDto }) seats!: SeatsDto;
  @ApiProperty({ enum: ParticipationStatus, nullable: true })
  viewerParticipation!: ParticipationStatus | null;
  @ApiProperty({ enum: InvitationStatus, nullable: true })
  viewerInvitation!: InvitationStatus | null;
  @ApiProperty({ type: GameJoinStateDto }) join!: GameJoinStateDto;
}

export class GamePageDto {
  @ApiProperty({ type: [GameSummaryDto] }) items!: GameSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class MyInvitationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: InvitationStatus }) status!: InvitationStatus;
  @ApiProperty({ type: PersonSummaryDto }) invitedBy!: PersonSummaryDto;
  @ApiProperty() priority!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) respondBy!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) heldUntil!: string | null;
  @ApiProperty({ description: 'False ⇒ show “Your invitation · outside current filters”' })
  matchesFilters!: boolean;
  @ApiProperty({ type: GameSummaryDto }) game!: GameSummaryDto;
}

export class MyInvitationsQuery {
  @ApiPropertyOptional({
    description: 'Feed filter params are accepted so the response can flag matchesFilters',
  })
  @IsOptional()
  @IsString()
  formats?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() kinds?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
}

export class AttachBookingDto {
  @ApiProperty({ description: 'A booking that fits the game (any usable status)' })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({ description: 'Current game version; stale => 409 VERSION_CHANGED' })
  @IsInt()
  version!: number;
}

export class SkippedInviteDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ description: 'Why this person was not invited (already in, no capacity, …)' })
  reason!: string;
}

export class InviteResultDto {
  @ApiProperty({ type: [InvitationDto] }) created!: InvitationDto[];
  @ApiProperty({ type: [SkippedInviteDto] }) skipped!: SkippedInviteDto[];
}
