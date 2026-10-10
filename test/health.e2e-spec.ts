import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { configureApp } from '../src/setup';

describe('health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ ping: () => Promise.resolve(false), $disconnect: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health is live without touching the database', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready fails when the DB is down', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error).toBeDefined();
  });

  it('unknown routes use the common error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('serves OpenAPI JSON outside production', async () => {
    const res = await request(app.getHttpServer()).get('/docs/openapi.json').expect(200);
    expect(res.body.paths['/health']).toBeDefined();
  });
});
