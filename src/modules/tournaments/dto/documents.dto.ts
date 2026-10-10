import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentRole, DocumentAudience } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PersonSummaryDto } from '../../users/person-summary';

export class CreateDocumentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @ApiProperty({ enum: DocumentAudience, description: 'Who must personally accept it' })
  @IsEnum(DocumentAudience)
  audience!: DocumentAudience;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() mandatory?: boolean;
  @ApiPropertyOptional({
    example: 'ka',
    description: 'Any language; the original is kept as uploaded',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;
  @ApiProperty({ description: 'READY document/photo media you own' })
  @IsUUID()
  fileMediaId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) checksum?: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @ApiPropertyOptional({ enum: DocumentAudience })
  @IsOptional()
  @IsEnum(DocumentAudience)
  audience?: DocumentAudience;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mandatory?: boolean;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string | null;
}

export class NewDocumentVersionDto {
  @ApiProperty() @IsUUID() fileMediaId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) checksum?: string;
}

export class ConsentRequestDto {
  @ApiProperty({
    description:
      'The version the person is agreeing to; a stale id is refused (409 VERSION_CHANGED)',
  })
  @IsUUID()
  versionId!: string;
}

export class RemindDto {
  @ApiPropertyOptional({ description: 'Only remind about this document' })
  @IsOptional()
  @IsUUID()
  documentId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Only these people' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds?: string[];
}

export class DocumentVersionDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() fileMediaId!: string;
  @ApiProperty({ nullable: true, type: String }) checksum!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class DocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() tournamentId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentAudience }) audience!: DocumentAudience;
  @ApiProperty() mandatory!: boolean;
  @ApiProperty({ nullable: true, type: String }) language!: string | null;
  @ApiProperty({ type: DocumentVersionDto, nullable: true })
  currentVersion!: DocumentVersionDto | null;
  @ApiProperty({ type: [DocumentVersionDto], description: 'Append-only history, newest first' })
  versions!: DocumentVersionDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class RequiredDocumentDto {
  @ApiProperty() documentId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentAudience }) audience!: DocumentAudience;
  @ApiProperty() mandatory!: boolean;
  @ApiProperty({ nullable: true, type: String }) language!: string | null;
  @ApiProperty({ type: DocumentVersionDto }) currentVersion!: DocumentVersionDto;
  @ApiProperty({
    enum: ConsentRole,
    isArray: true,
    description: 'Roles of mine this document applies to',
  })
  roles!: ConsentRole[];
  @ApiProperty({ description: 'I accepted the CURRENT version personally' }) accepted!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) acceptedAt!: string | null;
  @ApiProperty({ description: 'I accepted an older version; the new one needs a new acceptance' })
  acceptedOlderVersion!: boolean;
}

export class ConsentDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() versionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ConsentRole }) role!: ConsentRole;
  @ApiProperty({ type: String, format: 'date-time' }) acceptedAt!: string;
}

export class MatrixPersonDto {
  @ApiProperty({ type: PersonSummaryDto }) person!: PersonSummaryDto;
  @ApiProperty({ enum: ['CLUB_REP', 'PLAYER'] }) role!: string;
  @ApiProperty({ type: [String] }) missingDocumentIds!: string[];
}

export class MatrixEntryDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() clubId!: string;
  @ApiProperty() clubName!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [MatrixPersonDto] }) people!: MatrixPersonDto[];
}

export class MatrixDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentAudience }) audience!: DocumentAudience;
  @ApiProperty() mandatory!: boolean;
  @ApiProperty() version!: number;
}

export class ConsentMatrixDto {
  @ApiProperty({ type: [MatrixDocumentDto] }) documents!: MatrixDocumentDto[];
  @ApiProperty({ type: [MatrixEntryDto] }) entries!: MatrixEntryDto[];
  @ApiProperty({ description: 'People missing at least one mandatory document' })
  missingPeople!: number;
}

export class RemindResultDto {
  @ApiProperty() reminded!: number;
}
