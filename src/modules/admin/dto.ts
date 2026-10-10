import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthProvider, RecoveryStatus, UserStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination/cursor-page';

export class RecoveryCasesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: RecoveryStatus, default: 'OPEN' })
  @IsOptional()
  @IsEnum(RecoveryStatus)
  status?: RecoveryStatus;
}

export class ApproveRecoveryDto {
  @ApiProperty({ description: 'How ownership was verified (out of band). Mandatory.' })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  verificationNote!: string;
}

export class DeclineRecoveryDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}

export class AuditQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) targetType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) targetId?: string;
}

export class UserLookupQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Exact user id, or a username prefix' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

export class RecoveryCaseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: AuthProvider }) contactProvider!: AuthProvider;
  @ApiProperty({ description: 'The contact claimed in the request (staff only)' })
  contactSubject!: string;
  @ApiProperty({ nullable: true, type: String }) userId!: string | null;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
  @ApiProperty({ enum: RecoveryStatus }) status!: RecoveryStatus;
  @ApiProperty({ nullable: true, type: String }) reviewedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) verificationNote!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
}

export class RecoveryCasePageDto {
  @ApiProperty({ type: [RecoveryCaseDto] }) items!: RecoveryCaseDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class RecoveryApprovalDto {
  @ApiProperty({
    description: 'One-time token for the owner. Shown exactly once, never stored in clear.',
  })
  token!: string;
  @ApiProperty() expiresAt!: string;
}

export class AuditEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) actorId!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() targetType!: string;
  @ApiProperty({ nullable: true, type: String }) targetId!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) requestId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditEventDto] }) items!: AuditEventDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class StaffUserDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) username!: string | null;
  @ApiProperty({ nullable: true, type: String }) nickname!: string | null;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty() createdAt!: string;
}

export class StaffUserPageDto {
  @ApiProperty({ type: [StaffUserDto] }) items!: StaffUserDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

// account deletion

export class OwnedClubDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class UpcomingGameDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() startsAt!: string;
}
export class OpenObligationDto {
  @ApiProperty() id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ nullable: true, type: String }) eventId!: string | null;
  @ApiProperty({ description: 'Minor units still to pay (0 for refund rows)' })
  outstandingMinor!: number;
  @ApiProperty({ description: 'Minor units owed back to the user' }) refundDueMinor!: number;
  @ApiProperty() currency!: string;
}

export class DeletionBlockersDto {
  @ApiProperty({ type: [OwnedClubDto] }) ownedClubs!: OwnedClubDto[];
  @ApiProperty({ type: [UpcomingGameDto] }) upcomingGames!: UpcomingGameDto[];
  @ApiProperty({ type: [OpenObligationDto] }) openObligations!: OpenObligationDto[];
  @ApiProperty({ type: [OpenObligationDto] }) pendingRefunds!: OpenObligationDto[];
}

export class AccountDeletedDto {
  @ApiProperty({ example: 'DELETED' }) status!: 'DELETED';
}
