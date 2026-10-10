import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeeAmendmentStatus, type FeeAmendment } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PageMeta, PageQuery } from '../../common/pagination/cursor-page';
import { ObligationDto } from './dto';

/** Upper bound for a per-player fee: 100 000.00 in the currency's minor units. */
export const MAX_FEE_MINOR = 10_000_000;

export class ProposeFeeAmendmentDto {
  @ApiProperty({ minimum: 0, maximum: MAX_FEE_MINOR, description: 'New fee, minor units' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_FEE_MINOR)
  newPriceMinor!: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RespondFeeAmendmentDto {
  @ApiProperty({ description: 'The amendment `version` the client saw (optimistic concurrency)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class ListFeeAmendmentsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: FeeAmendmentStatus })
  @IsOptional()
  @IsEnum(FeeAmendmentStatus)
  status?: FeeAmendmentStatus;
}

export class FeeAmendmentCapabilitiesDto {
  @ApiProperty({ description: 'Viewer is the affected participant and it is still pending' })
  canAccept!: boolean;
  @ApiProperty() canReject!: boolean;
  @ApiProperty({ description: 'Viewer may change fees for the game and it is still pending' })
  canCancel!: boolean;
}

export class FeeAmendmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() obligationId!: string;
  @ApiProperty() participantId!: string;
  @ApiProperty({ description: 'Amount owed when the change was proposed, minor units' })
  oldAmountMinor!: number;
  @ApiProperty({ description: 'Amount owed if the participant accepts, minor units' })
  newAmountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ enum: FeeAmendmentStatus }) status!: FeeAmendmentStatus;
  @ApiProperty() proposedById!: string;
  @ApiProperty({ nullable: true, type: String }) respondedById!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) respondedAt!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: FeeAmendmentCapabilitiesDto })
  capabilities!: FeeAmendmentCapabilitiesDto;
  @ApiPropertyOptional({
    type: ObligationDto,
    description: 'Present on accept/reject/cancel results: the obligation after the action',
  })
  obligation?: ObligationDto;

  static from(a: FeeAmendment, capabilities: FeeAmendmentCapabilitiesDto): FeeAmendmentDto {
    return {
      id: a.id,
      eventId: a.eventId,
      obligationId: a.obligationId,
      participantId: a.participantId,
      oldAmountMinor: a.oldAmountMinor,
      newAmountMinor: a.newAmountMinor,
      currency: a.currency,
      reason: a.reason,
      status: a.status,
      proposedById: a.proposedById,
      respondedById: a.respondedById,
      respondedAt: a.respondedAt?.toISOString() ?? null,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
      capabilities,
    };
  }
}

export class ProposeFeeAmendmentResultDto {
  @ApiProperty() eventId!: string;
  @ApiProperty({ description: 'The game price now applied to new joiners, minor units' })
  priceMinor!: number;
  @ApiProperty({ description: 'Number of participants who were asked to accept the new fee' })
  proposed!: number;
  @ApiProperty({ type: [FeeAmendmentDto] }) amendments!: FeeAmendmentDto[];
}

export class FeeAmendmentPageDto extends PageMeta {
  @ApiProperty({ type: [FeeAmendmentDto] }) items!: FeeAmendmentDto[];
}
