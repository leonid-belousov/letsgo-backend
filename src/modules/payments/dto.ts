import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AdjustmentType,
  ObligationKind,
  ObligationStatus,
  type Adjustment,
  type CashReceipt,
  type PaymentObligation,
} from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CashReceiptDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Minor units (tetri for GEL)' }) amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'The real acting user (never editable)' }) receivedById!: string;
  @ApiProperty({ type: String, format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;

  static from(r: CashReceipt): CashReceiptDto {
    return {
      id: r.id,
      amountMinor: r.amountMinor,
      currency: r.currency,
      receivedById: r.receivedById,
      receivedAt: r.receivedAt.toISOString(),
      note: r.note,
    };
  }
}

export class AdjustmentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: AdjustmentType }) type!: AdjustmentType;
  @ApiProperty({ description: 'Signed minor units' }) deltaMinor!: number;
  @ApiProperty() reason!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty({ nullable: true, type: String }) receiptId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;

  static from(a: Adjustment): AdjustmentDto {
    return {
      id: a.id,
      type: a.type,
      deltaMinor: a.deltaMinor,
      reason: a.reason,
      actorId: a.actorId,
      receiptId: a.receiptId,
      createdAt: a.createdAt.toISOString(),
    };
  }
}

export class ObligationCapabilitiesDto {
  @ApiProperty({ description: 'Payer may say "Pay cash" (does not mean paid)' })
  canPayCash!: boolean;
  @ApiProperty({ description: 'Viewer is an authorised receiver and not the payer' })
  canConfirmCash!: boolean;
  @ApiProperty() canCorrect!: boolean;
  @ApiProperty({ description: 'Always false at launch: no payment gateway exists' })
  canPayOnline!: boolean;
}

export class PendingAmendmentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Amount owed if the payer accepts, minor units' })
  newAmountMinor!: number;
  @ApiProperty({ description: 'Send back as `version` when accepting/rejecting' })
  version!: number;
}

export class ObligationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ObligationKind }) kind!: ObligationKind;
  @ApiProperty({ nullable: true, type: String }) payerUserId!: string | null;
  @ApiProperty({ nullable: true, type: String }) payerClubId!: string | null;
  @ApiProperty({ nullable: true, type: String }) eventId!: string | null;
  @ApiProperty({ nullable: true, type: String }) tournamentId!: string | null;
  @ApiProperty({ description: 'Minor units' }) amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ObligationStatus }) status!: ObligationStatus;
  @ApiProperty() paidMinor!: number;
  @ApiProperty({ description: 'amount − paid, never negative' }) remainingMinor!: number;
  @ApiProperty() refundDueMinor!: number;
  @ApiProperty() refundedMinor!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) payCashRequestedAt!:
    string | null;
  @ApiProperty({ type: ObligationCapabilitiesDto }) capabilities!: ObligationCapabilitiesDto;
  @ApiPropertyOptional({
    type: PendingAmendmentDto,
    description:
      'A proposed change of the amount awaiting the payer’s acceptance. The amount above stays unchanged until accepted.',
  })
  pendingAmendment?: PendingAmendmentDto;
  @ApiPropertyOptional({ type: [CashReceiptDto] }) receipts?: CashReceiptDto[];
  @ApiPropertyOptional({ type: [AdjustmentDto] }) adjustments?: AdjustmentDto[];

  static from(o: PaymentObligation, capabilities: ObligationCapabilitiesDto): ObligationDto {
    return {
      id: o.id,
      kind: o.kind,
      payerUserId: o.payerUserId,
      payerClubId: o.payerClubId,
      eventId: o.eventId,
      tournamentId: o.tournamentId,
      amountMinor: o.amountMinor,
      currency: o.currency,
      status: o.status,
      paidMinor: o.paidMinor,
      remainingMinor: Math.max(0, o.amountMinor - o.paidMinor),
      refundDueMinor: o.refundDueMinor,
      refundedMinor: o.refundedMinor,
      payCashRequestedAt: o.payCashRequestedAt?.toISOString() ?? null,
      capabilities,
    };
  }
}

export class CashReceivedDto {
  @ApiPropertyOptional({
    description: 'Minor units. Omit to confirm the whole remaining amount ("Cash received").',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CreateAdjustmentDto {
  @ApiProperty({ enum: AdjustmentType }) @IsEnum(AdjustmentType) type!: AdjustmentType;
  @ApiProperty({ description: 'Signed for CORRECTION/WAIVER, positive for REFUND_*' })
  @Type(() => Number)
  @IsInt()
  deltaMinor!: number;
  @ApiProperty() @IsString() @MaxLength(300) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() receiptId?: string;
}

export class EventMoneySummaryDto {
  @ApiProperty() eventId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Sum of obligations of confirmed players' }) expectedMinor!: number;
  @ApiProperty() collectedMinor!: number;
  @ApiProperty() outstandingMinor!: number;
  @ApiProperty() paidCount!: number;
  @ApiProperty() obligationCount!: number;
  @ApiProperty({ type: [ObligationDto] }) obligations!: ObligationDto[];
}
