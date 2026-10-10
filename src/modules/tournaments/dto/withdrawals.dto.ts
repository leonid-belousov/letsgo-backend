import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WithdrawalResolution, WithdrawalStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
import { ClubRefDto } from './entries.dto';

export class RequestWithdrawalDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class TechnicalResultDto {
  @ApiProperty() @IsUUID() fixtureId!: string;
  @ApiProperty({ description: 'Explicit score - there is no default such as 3:0' })
  @IsInt()
  @Min(0)
  @Max(99)
  homeScore!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(99) awayScore!: number;
}

export class ResolveWithdrawalDto {
  @ApiProperty({ enum: WithdrawalResolution })
  @IsEnum(WithdrawalResolution)
  resolution!: WithdrawalResolution;
  @ApiProperty({ description: 'The organiser states the decision in words (kept in the record)' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
  @ApiPropertyOptional({
    description:
      'REPLACEMENT: another ACCEPTED entry, or an APPLIED / WAITLISTED one that is accepted by this decision',
  })
  @IsOptional()
  @IsUUID()
  replacementEntryId?: string;
  @ApiPropertyOptional({
    type: [TechnicalResultDto],
    description: 'TECHNICAL_RESULT: required, explicit scores for unplayed fixtures of the club',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TechnicalResultDto)
  technicalResults?: TechnicalResultDto[];
}

export class WithdrawalDto {
  @ApiProperty() id!: string;
  @ApiProperty() tournamentId!: string;
  @ApiProperty() entryId!: string;
  @ApiProperty({ type: ClubRefDto, nullable: true }) club!: ClubRefDto | null;
  @ApiProperty() requestedById!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: WithdrawalStatus }) status!: WithdrawalStatus;
  @ApiProperty({ enum: WithdrawalResolution, nullable: true })
  resolution!: WithdrawalResolution | null;
  @ApiProperty({ nullable: true, type: String }) resolutionNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) resolvedById!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) resolvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacementEntryId!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'What the decision changed (fixture ids)',
  })
  details!: Record<string, unknown> | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class WithdrawalListDto {
  @ApiProperty({ type: [WithdrawalDto] }) items!: WithdrawalDto[];
}
