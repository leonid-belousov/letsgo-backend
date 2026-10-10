import { createTestApp, type TestApp } from './support/app';

/**
 * Client generators (`npm run api:generate`) only see what OpenAPI documents. Every operation whose
 * controller reads a query DTO must expose its parameters, otherwise typed clients cannot call it.
 */
describe('OpenAPI contract', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  interface Param {
    name: string;
    in: string;
  }
  interface Doc {
    paths: Record<
      string,
      Record<
        string,
        {
          operationId: string;
          parameters?: Param[];
          responses?: Record<string, { content?: Record<string, unknown> }>;
        }
      >
    >;
  }

  it('documents the query parameters of DTO-driven GET endpoints', async () => {
    const doc = (await t.http().get('/docs/openapi.json').expect(200)).body as Doc;
    const query = (path: string) =>
      (doc.paths[path]?.get?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(query('/v1/users/username-available')).toEqual(['username']);
    expect(query('/v1/grants')).toEqual(expect.arrayContaining(['resourceType']));
  });

  it('documents the body of endpoints clients read (blocks, unread counts)', async () => {
    const doc = (await t.http().get('/docs/openapi.json').expect(200)).body as Doc;
    for (const path of [
      '/v1/me/blocks',
      '/v1/activity/unread-count',
      '/v1/chat/unread-count',
      '/v1/notifications/unread-count',
    ]) {
      expect(doc.paths[path]?.get?.responses?.['200']?.content).toBeDefined();
    }
  });

  it('has no property typed as a bare object (generated clients would type it as Record<string, never>)', async () => {
    const doc = (await t.http().get('/docs/openapi.json').expect(200)).body as {
      components: { schemas: Record<string, { properties?: Record<string, Prop> }> };
    };
    interface Prop {
      type?: string;
      properties?: unknown;
      additionalProperties?: unknown;
      oneOf?: unknown;
      allOf?: unknown;
      $ref?: string;
    }
    const bare: string[] = [];
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      for (const [prop, def] of Object.entries(schema.properties ?? {})) {
        if (
          def.type === 'object' &&
          !def.properties &&
          !def.additionalProperties &&
          !def.allOf &&
          !def.oneOf &&
          !def.$ref
        ) {
          bare.push(`${name}.${prop}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it('has unique operation ids', async () => {
    const doc = (await t.http().get('/docs/openapi.json').expect(200)).body as Doc;
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
