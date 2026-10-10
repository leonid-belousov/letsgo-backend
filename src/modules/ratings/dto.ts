import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RatingSubject } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export class UpsertRatingDto {
  @ApiProperty() @IsUUID() eventId!: string;
  @ApiProperty({ enum: RatingSubject }) @IsEnum(RatingSubject) subjectType!: RatingSubject;
  @ApiProperty({ description: 'User id (PLAYER/ORGANISER/REFEREE), pitch id or venue id' })
  @IsUUID()
  subjectId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) score!: number;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
  @ApiPropertyOptional({
    description:
      'Optional extended characteristics (flat object, ≤ 20 keys). Never prefilled from the overall score.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  extended?: Record<string, unknown>;
}

export class HideRatingDto {
  @ApiProperty({ description: 'Recorded in the audit log' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RatingsPageQuery extends PageQuery {}

export class RatingDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RatingSubject }) subjectType!: RatingSubject;
  @ApiProperty() subjectId!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) score!: number;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  extended!: Record<string, unknown> | null;
  @ApiProperty() editableUntil!: string;
  @ApiProperty({ description: 'False once the edit window closed' }) canEdit!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RatingsGivenPageDto {
  @ApiProperty({ type: [RatingDto] }) items!: RatingDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

/** What the subject sees: no author identity. */
export class ReceivedRatingDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RatingSubject }) subjectType!: RatingSubject;
  @ApiProperty() eventId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) score!: number;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  extended!: Record<string, unknown> | null;
  @ApiProperty() createdAt!: string;
}

export class RatingsReceivedPageDto {
  @ApiProperty({ type: [ReceivedRatingDto] }) items!: ReceivedRatingDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class SubjectRatingDto {
  @ApiProperty({ enum: RatingSubject }) subjectType!: RatingSubject;
  @ApiProperty() subjectId!: string;
  @ApiProperty({
    description: 'True ⇒ the owner hid ratings from this viewer; no numbers are returned',
  })
  hidden!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Simple arithmetic mean, 1 decimal. null = no ratings yet (never 0)',
  })
  average?: number | null;
  @ApiPropertyOptional() count?: number;
}

export class RateableSubjectDto {
  @ApiProperty({ enum: RatingSubject }) subjectType!: RatingSubject;
  @ApiProperty() subjectId!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ type: RatingDto, nullable: true }) myRating!: RatingDto | null;
}

export class EventRatingsDto {
  @ApiProperty() eventId!: string;
  @ApiProperty() canRate!: boolean;
  @ApiProperty({ type: [RateableSubjectDto] }) subjects!: RateableSubjectDto[];
}

export class AdminRatingDto {
  @ApiProperty() id!: string;
  @ApiProperty() hidden!: boolean;
  @ApiProperty({ nullable: true, type: String }) hiddenAt!: string | null;
}
