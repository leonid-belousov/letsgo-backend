import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../common/time/clock';
import { parseCsv, type Env } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthNonceService } from './nonce.service';
import {
  appleNonceMatches,
  CompositeProviderVerifier,
  googleNonceMatches,
  IdTokenVerifier,
  PROVIDER_JWKS,
  ProviderVerifier,
  remoteProviderJwks,
  UnconfiguredProviderVerifier,
  type ProviderJwks,
} from './provider-verifier';
import { RecoveryService } from './recovery.service';

/**
 * Chooses the adapter per provider from configuration: a provider with client ids gets a real
 * jose-based ID-token verifier; one without answers 503 PROVIDER_NOT_CONFIGURED.
 */
export function createProviderVerifier(
  config: ConfigService<Env, true>,
  clock: Clock,
  jwks: ProviderJwks,
): ProviderVerifier {
  // ConfigService may hand back the raw process.env string, so normalise defensively.
  const google = parseCsv(config.get('GOOGLE_CLIENT_IDS', { infer: true }));
  const apple = parseCsv(config.get('APPLE_CLIENT_IDS', { infer: true }));
  return new CompositeProviderVerifier({
    GOOGLE:
      google.length > 0
        ? new IdTokenVerifier({
            provider: 'GOOGLE',
            issuers: ['https://accounts.google.com', 'accounts.google.com'],
            audiences: google,
            jwks: jwks.GOOGLE,
            now: () => clock.now(),
            nonceMatches: googleNonceMatches,
          })
        : new UnconfiguredProviderVerifier(),
    APPLE:
      apple.length > 0
        ? new IdTokenVerifier({
            provider: 'APPLE',
            issuers: ['https://appleid.apple.com'],
            audiences: apple,
            jwks: jwks.APPLE,
            now: () => clock.now(),
            nonceMatches: appleNonceMatches,
          })
        : new UnconfiguredProviderVerifier(),
  });
}

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    RecoveryService,
    AuthNonceService,
    // Overridable in tests with locally generated key sets (jose createLocalJWKSet).
    { provide: PROVIDER_JWKS, useFactory: remoteProviderJwks },
    {
      provide: ProviderVerifier,
      inject: [ConfigService, Clock, PROVIDER_JWKS],
      useFactory: createProviderVerifier,
    },
  ],
  exports: [AuthService, RecoveryService],
})
export class AuthModule {}
