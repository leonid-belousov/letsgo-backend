import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSponsorDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiPropertyOptional({ description: 'READY photo you own' })
  @IsOptional()
  @IsUUID()
  logoMediaId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string;
}

export class UpdateSponsorDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null removes the logo' })
  @IsOptional()
  @IsUUID()
  logoMediaId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string | null;
  @ApiPropertyOptional({
    description: 'Hide/show on the public page (hiding the Main sponsor clears the designation)',
  })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;
}

export class AddSponsorAssetDto {
  @ApiProperty({ description: 'READY photo/video you own' }) @IsUUID() mediaId!: string;
}

export class UpdateSponsorAssetDto {
  @ApiProperty() @IsBoolean() hidden!: boolean;
}

export class ReorderDto {
  @ApiProperty({ type: [String], description: 'Complete list of ids in the new order' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class SetMainSponsorDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Sponsor of THIS tournament, or null for none',
  })
  @IsOptional()
  @IsUUID()
  sponsorId!: string | null;
}

export class SponsorAssetDto {
  @ApiProperty() id!: string;
  @ApiProperty() mediaId!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ description: 'Only managers see hidden materials' }) hidden!: boolean;
}

export class SponsorDto {
  @ApiProperty() id!: string;
  @ApiProperty() tournamentId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) logoMediaId!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalUrl!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() hidden!: boolean;
  @ApiProperty() isMain!: boolean;
  @ApiProperty({ type: [SponsorAssetDto] }) assets!: SponsorAssetDto[];
}

export class SponsorListDto {
  @ApiProperty({ type: [SponsorDto] }) items!: SponsorDto[];
  @ApiProperty({ nullable: true, type: String }) mainSponsorId!: string | null;
}
