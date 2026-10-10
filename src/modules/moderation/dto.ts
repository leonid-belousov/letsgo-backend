import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export const MODERATION_ACTIONS = [
  'HIDE_POST',
  'REMOVE_COMMENT',
  'REMOVE_MEDIA',
  'SUSPEND_USER',
  'RESTORE_USER',
  'WARN',
] as const;
export type ModerationActionName = (typeof MODERATION_ACTIONS)[number];

// ───────────── requests ─────────────

export class CreateReportDto {
  @ApiProperty({ enum: ReportTargetType }) @IsEnum(ReportTargetType) targetType!: ReportTargetType;
  @ApiProperty() @IsUUID() targetId!: string;
  @ApiProperty({ enum: ReportReason }) @IsEnum(ReportReason) reason!: ReportReason;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}

export class MyReportsQuery extends PageQuery {}

export class ReportQueueQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ReportStatus })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;
  @ApiPropertyOptional({ enum: ReportTargetType })
  @IsOptional()
  @IsEnum(ReportTargetType)
  targetType?: ReportTargetType;
}

export class ResolveReportDto {
  @ApiProperty({ maxLength: 1000 }) @IsString() @MinLength(3) @MaxLength(1000) resolution!: string;
}

export class ApplyModerationActionDto {
  @ApiPropertyOptional({ description: 'The report this action answers (optional)' })
  @IsOptional()
  @IsUUID()
  reportId?: string;
  @ApiProperty({ enum: MODERATION_ACTIONS })
  @IsIn(MODERATION_ACTIONS)
  action!: ModerationActionName;
  @ApiProperty({
    enum: ReportTargetType,
    description: 'HIDE_POST→POST, REMOVE_COMMENT→COMMENT, REMOVE_MEDIA→MEDIA, others→USER',
  })
  @IsEnum(ReportTargetType)
  targetType!: ReportTargetType;
  @ApiProperty() @IsUUID() targetId!: string;
  @ApiProperty({ description: 'Mandatory; kept in the moderation record and the audit log' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// ───────────── responses ─────────────

export class ReportReceiptDto {
  @ApiProperty() ticketNumber!: number;
  @ApiProperty({ enum: ReportStatus }) status!: ReportStatus;
  @ApiProperty({
    example: 'Report sent',
    description: 'A receipt only — removal is never promised',
  })
  message!: string;
}

/** What a reporter sees: never moderator identities or decisions' authors. */
export class MyReportDto {
  @ApiProperty() ticketNumber!: number;
  @ApiProperty({ enum: ReportStatus }) status!: ReportStatus;
  @ApiProperty({ enum: ReportTargetType }) targetType!: ReportTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ enum: ReportReason }) reason!: ReportReason;
  @ApiProperty() createdAt!: string;
}

export class MyReportsPageDto {
  @ApiProperty({ type: [MyReportDto] }) items!: MyReportDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class AdminReportDto {
  @ApiProperty() id!: string;
  @ApiProperty() ticketNumber!: number;
  @ApiProperty({ enum: ReportStatus }) status!: ReportStatus;
  @ApiProperty({ enum: ReportTargetType }) targetType!: ReportTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty({ enum: ReportReason }) reason!: ReportReason;
  @ApiProperty({ nullable: true, type: String }) text!: string | null;
  @ApiProperty() reporterId!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) resolvedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) resolution!: string | null;
  @ApiProperty({ nullable: true, type: String }) resolvedAt!: string | null;
}

export class AdminReportPageDto {
  @ApiProperty({ type: [AdminReportDto] }) items!: AdminReportDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ModerationActionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) reportId!: string | null;
  @ApiProperty() moderatorId!: string;
  @ApiProperty({ enum: MODERATION_ACTIONS }) action!: string;
  @ApiProperty({ enum: ReportTargetType }) targetType!: ReportTargetType;
  @ApiProperty() targetId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() createdAt!: string;
}

export class TargetPreviewDto {
  @ApiProperty() exists!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Author / owner of the reported object',
  })
  ownerId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Short excerpt (max 200 chars) for context',
  })
  excerpt!: string | null;
  @ApiProperty({ nullable: true, type: String }) state!: string | null;
}

export class AdminReportDetailDto extends AdminReportDto {
  @ApiProperty({ type: TargetPreviewDto }) target!: TargetPreviewDto;
  @ApiProperty({ type: [ModerationActionDto] }) actions!: ModerationActionDto[];
}
