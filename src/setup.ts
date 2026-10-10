import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { Env } from './config/env';

/** Shared bootstrap so tests exercise the same pipeline as production. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Proxy trust is explicit per deployment (never blindly true): it decides whose X-Forwarded-For
  // is believed, which feeds rate limiting and request logs.
  const trust = config.get('TRUST_PROXY', { infer: true }).trim();
  if (trust && trust.toLowerCase() !== 'false') {
    const hops = Number(trust);
    (app as unknown as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      Number.isInteger(hops) ? hops : trust.split(',').map((x) => x.trim()),
    );
  }
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });
  app.use(helmet());
  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle("Let'sGo API")
      .setDescription('Let’sGo backend — source of truth for business state and permissions')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, doc);
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }
}
