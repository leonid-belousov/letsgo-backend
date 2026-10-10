import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaKind, MediaStatus, MediaVisibility } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MiB = 1024 * 1024;

/** Product limits (Handoff §12 / Decisions): photo ≤ 20 MB, video ≤ 500 MB and ≤ 300 s, document ≤ 25 MB. */
export const MEDIA_LIMITS: Record<
  MediaKind,
  { maxBytes: number; maxDurationSeconds: number | null; mimeTypes: readonly string[] }
> = {
  PHOTO: {
    maxBytes: 20 * MiB,
    maxDurationSeconds: null,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  VIDEO: {
    maxBytes: 500 * MiB,
    maxDurationSeconds: 300,
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
  },
  DOCUMENT: { maxBytes: 25 * MiB, maxDurationSeconds: null, mimeTypes: ['application/pdf'] },
};

export class CreateUploadDto {
  @ApiProperty({ enum: MediaKind }) @IsEnum(MediaKind) kind!: MediaKind;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z]+\/[a-z0-9.+-]+$/)
  mimeType!: string;

  @ApiProperty({ description: 'Declared size in bytes; the real upload may not exceed it' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Videos only; max 300 seconds' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  durationSeconds?: number;

  @ApiPropertyOptional({ enum: MediaVisibility, default: 'PRIVATE' })
  @IsOptional()
  @IsEnum(MediaVisibility)
  visibility?: MediaVisibility;
}

export class FinalizeUploadDto {
  @ApiPropertyOptional({
    description: 'Optional client SHA-256 (hex); mismatch marks the upload FAILED',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i)
  checksum?: string;
}

export const MEDIA_VARIANTS = ['original', 'thumb', 'card'] as const;
export type MediaVariantLabel = (typeof MEDIA_VARIANTS)[number];

export class VariantInfoDto {
  @ApiProperty({ example: 'thumb' }) label!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

export class UrlQuery {
  @ApiPropertyOptional({ enum: MEDIA_VARIANTS, default: 'original' })
  @IsOptional()
  @IsIn(MEDIA_VARIANTS)
  variant?: MediaVariantLabel;
}

export class UploadInstructionsDto {
  @ApiProperty({ example: 'PUT' }) method!: string;
  @ApiProperty() path!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() maxBytes!: number;
}

export class MediaAssetDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MediaKind }) kind!: MediaKind;
  @ApiProperty({ enum: MediaStatus }) status!: MediaStatus;
  @ApiProperty({ enum: MediaVisibility }) visibility!: MediaVisibility;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ nullable: true, type: Number }) durationSeconds!: number | null;
  @ApiProperty({ nullable: true, type: String }) checksum!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Why the upload failed (owner only)' })
  failureReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) readyAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Pixel width after processing (photos)',
  })
  width!: number | null;
  @ApiProperty({ nullable: true, type: Number }) height!: number | null;
  @ApiProperty({
    description: 'true once EXIF/GPS/XMP/IPTC were dropped by re-encoding (photos only)',
  })
  metadataStripped!: boolean;
  @ApiProperty({
    type: [VariantInfoDto],
    description: 'Available derived sizes; fetch via /url?variant=',
  })
  variants!: VariantInfoDto[];
  @ApiPropertyOptional({ type: UploadInstructionsDto, description: 'Present on a fresh intent' })
  upload?: UploadInstructionsDto;
}

export class MediaPageDto {
  @ApiProperty({ type: [MediaAssetDto] }) items!: MediaAssetDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class SignedUrlDto {
  @ApiProperty({ description: 'Relative URL, short-lived (≤ 5 minutes). Never store or share it.' })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class ContentQuery {
  @ApiProperty() @IsString() @MaxLength(400) token!: string;
}
