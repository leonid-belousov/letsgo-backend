import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GrantResourceType, RoleGrant } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PERMISSION_CATALOG } from '../../common/permissions/permissions';

export class CreateGrantDto {
  @ApiProperty() @IsUUID() granteeId!: string;
  @ApiProperty({ enum: GrantResourceType })
  @IsEnum(GrantResourceType)
  resourceType!: GrantResourceType;
  @ApiPropertyOptional({ description: 'Required unless resourceType is PLATFORM' })
  @IsOptional()
  @IsUUID()
  resourceId?: string;
  @ApiProperty({ enum: Object.keys(PERMISSION_CATALOG) })
  @IsString()
  @IsIn(Object.keys(PERMISSION_CATALOG))
  permission!: string;
  @ApiPropertyOptional({ description: '"Can pass on"' })
  @IsOptional()
  @IsBoolean()
  canPassOn?: boolean;
  @ApiPropertyOptional({ description: 'Delegates may themselves receive "can pass on"' })
  @IsOptional()
  @IsBoolean()
  furtherDelegation?: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}

export class RevokeGrantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class GrantDto {
  @ApiProperty() id!: string;
  @ApiProperty() granteeId!: string;
  @ApiProperty({ enum: GrantResourceType }) resourceType!: GrantResourceType;
  @ApiProperty({ nullable: true, type: String }) resourceId!: string | null;
  @ApiProperty() permission!: string;
  @ApiProperty() canPassOn!: boolean;
  @ApiProperty() furtherDelegation!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Set when delegated from another grant',
  })
  sourceGrantId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;

  static from(g: RoleGrant): GrantDto {
    return {
      id: g.id,
      granteeId: g.granteeId,
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      permission: g.permission,
      canPassOn: g.canPassOn,
      furtherDelegation: g.furtherDelegation,
      sourceGrantId: g.sourceGrantId,
      expiresAt: g.expiresAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
    };
  }
}

/**
 * Server-owned permission catalogue used by clients to render grant editors.
 * The catalogue describes actions only; it never grants access by itself.
 */
export class PermissionCatalogItemDto {
  @ApiProperty({ enum: Object.keys(PERMISSION_CATALOG) })
  permission!: string;

  @ApiProperty({ enum: GrantResourceType, isArray: true })
  resources!: GrantResourceType[];

  @ApiProperty({ description: 'Whether a holder may delegate this action' })
  delegable!: boolean;
}
