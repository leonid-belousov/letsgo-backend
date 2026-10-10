import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const E164 = /^\+[1-9]\d{6,14}$/;

/** Exactly one of email / phone identifies the account. */
export class ContactDto {
  @ApiPropertyOptional({ example: 'player@example.test' })
  @ValidateIf((o: ContactDto) => !o.phone)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '+995000000000', description: 'E.164' })
  @ValidateIf((o: ContactDto) => !o.email)
  @Matches(E164, { message: 'phone must be in E.164 format' })
  phone?: string;
}

export class RegisterDto extends ContactDto {
  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}

export class LoginDto extends ContactDto {
  @ApiProperty() @IsString() @MaxLength(128) password!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @MaxLength(200) refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

export class RecoveryRequestDto extends ContactDto {
  @ApiPropertyOptional({ description: 'Free text for the support team' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export class RecoveryRedeemDto {
  @ApiProperty() @IsString() @MaxLength(200) token!: string;
  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

export class NonceDto {
  @ApiProperty({ description: 'Single-use, 10 minutes. Put it in the provider sign-in request.' })
  nonce!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
}

export class ProviderLoginDto {
  @ApiProperty({ description: 'Provider ID token' }) @IsString() @MaxLength(4096) idToken!: string;
  @ApiPropertyOptional({
    description:
      'Nonce from POST /auth/nonce. Required once the provider is configured. The ID token must carry it (Apple: raw or sha256 hex).',
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  nonce?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}

export class LinkProviderDto {
  @ApiProperty({ description: 'Provider ID token' }) @IsString() @MaxLength(4096) idToken!: string;
  @ApiPropertyOptional({ description: 'Nonce from POST /auth/nonce (required once configured)' })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  nonce?: string;
}

export class IdentityDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['EMAIL', 'PHONE', 'GOOGLE', 'APPLE'] }) provider!: string;
  @ApiProperty({ type: String, format: 'date-time' }) linkedAt!: string;
  @ApiProperty({ description: 'This login method has a password' }) hasPassword!: boolean;
  @ApiProperty({ description: 'Unlinking it would still leave another usable login method' })
  canUnlink!: boolean;
}

export class SessionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) deviceName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) lastUsedAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty() current!: boolean;
}

export class TokenPairDto {
  @ApiProperty({ description: 'Short-lived JWT bound to the session' }) accessToken!: string;
  @ApiProperty({ description: 'Opaque, rotated on every refresh; shown once' })
  refreshToken!: string;
  @ApiProperty({ description: 'Access token lifetime in seconds' }) expiresIn!: number;
  @ApiProperty() sessionId!: string;
  @ApiProperty() userId!: string;
}
