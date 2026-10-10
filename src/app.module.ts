import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.service';
import { AuthGuard, AuthKernelModule } from './common/auth/auth.guard';
import { ApiExceptionFilter } from './common/errors';
import { IdempotencyModule } from './common/idempotency/idempotency.service';
import { PermissionsModule } from './common/permissions/policy.service';
import { NotifyModule } from './common/notify/notifier.service';
import { ClockModule } from './common/time/clock';
import { Env, validateEnv } from './config/env';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { SecurityModule } from './infrastructure/security/password-hasher';
import { AccessModule } from './modules/access/access.module';
import { ActivityModule } from './modules/activity/activity.module';
import { ChatModule } from './modules/chat/chat.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuthModule } from './modules/auth/auth.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { ClubsModule } from './modules/clubs/clubs.module';
import { GamesModule } from './modules/games/games.module';
import { HealthModule } from './modules/health/health.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { MediaModule } from './modules/media/media.module';
import { PostsModule } from './modules/posts/posts.module';
import { SearchModule } from './modules/search/search.module';
import { SocialModule } from './modules/social/social.module';
import { TournamentsModule } from './modules/tournaments/tournaments.module';
import { UsersModule } from './modules/users/users.module';
import { VenuesModule } from './modules/venues/venues.module';
import { AchievementsModule } from './modules/achievements/achievements.module';
import { AdminModule } from './modules/admin/admin.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { ResultsModule } from './modules/results/results.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Never log credentials or tokens.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.token',
              'req.body.refreshToken',
              'req.body.idToken',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: { ignore: (req) => req.url === '/health' },
          // Query strings can carry short-lived signed tokens (media URLs): never log them.
          serializers: {
            req: (req: {
              id: unknown;
              method: string;
              url: string;
              headers: Record<string, unknown>;
            }) => ({
              id: req.id,
              method: req.method,
              url: req.url.split('?')[0],
            }),
          },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        skipIf: () => config.get('THROTTLE_DISABLED', { infer: true }),
      }),
    }),
    PrismaModule,
    ClockModule,
    SecurityModule,
    AuditModule,
    NotifyModule,
    IdempotencyModule,
    PermissionsModule,
    AuthKernelModule,
    PrivacyModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AccessModule,
    PostsModule,
    MediaModule,
    SocialModule,
    SearchModule,
    PaymentsModule,
    GamesModule,
    MaintenanceModule,
    ResultsModule,
    RatingsModule,
    ModerationModule,
    AdminModule,
    AchievementsModule,
    NotificationsModule,
    ChatModule,
    ActivityModule,
    ClubsModule,
    TournamentsModule,
    VenuesModule,
    BookingsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Order matters: rate-limit first (cheap), then authenticate.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
