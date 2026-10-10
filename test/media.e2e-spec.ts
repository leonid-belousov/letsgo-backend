import { Clock } from '../src/common/time/clock';
import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { block, pngBytes, publishPost, realPng, uploadPhoto } from './social-helpers';

describe('media (e2e)', () => {
  let t: TestApp;
  let offsetMs = 0;
  beforeAll(async () => {
    t = await createTestApp((b) =>
      b.overrideProvider(Clock).useValue({ now: () => new Date(Date.now() + offsetMs) }),
    );
  });
  afterAll(() => t.close());
  afterEach(() => {
    offsetMs = 0;
  });

  const intent = (auth: { Authorization: string }, body: Record<string, unknown>) =>
    t.http().post('/v1/media/uploads').set(auth).send(body);

  it('rejects beforehand with the concrete limit in details', async () => {
    const u = await createUser(t);
    const big = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: 20 * 1024 * 1024 + 1,
    });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('UPLOAD_FAILED');
    expect(big.body.error.details.maxBytes).toBe(20 * 1024 * 1024);

    const video = await intent(u.auth, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      sizeBytes: 500 * 1024 * 1024 + 1,
    });
    expect(video.status).toBe(422);
    expect(video.body.error.details.maxBytes).toBe(500 * 1024 * 1024);

    const long = await intent(u.auth, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      sizeBytes: 1000,
      durationSeconds: 301,
    });
    expect(long.status).toBe(422);
    expect(long.body.error.details.maxDurationSeconds).toBe(300);

    const doc = await intent(u.auth, {
      kind: 'DOCUMENT',
      mimeType: 'application/pdf',
      sizeBytes: 25 * 1024 * 1024 + 1,
    });
    expect(doc.status).toBe(422);
    expect(doc.body.error.details.maxBytes).toBe(25 * 1024 * 1024);

    const mime = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'application/x-msdownload',
      sizeBytes: 10,
    });
    expect(mime.status).toBe(422);
    expect(mime.body.error.details.allowed).toContain('image/png');

    const okVideo = await intent(u.auth, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      sizeBytes: 1000,
      durationSeconds: 300,
    });
    expect(okVideo.status).toBe(201);
    expect(okVideo.body.status).toBe('UPLOADING');
  });

  it('happy path: UPLOADING → PROCESSING → READY with checksum; finalize is idempotent', async () => {
    const u = await createUser(t);
    const bytes = await realPng();
    const created = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: bytes.length + 100,
    }).expect(201);
    const id = created.body.id as string;
    expect(created.body.upload.path).toBe(`/v1/media/${id}/content`);
    const up = await t
      .http()
      .put(`/v1/media/${id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/png')
      .send(bytes)
      .expect(200);
    expect(up.body.status).toBe('PROCESSING');
    expect(up.body.sizeBytes).toBe(bytes.length);
    const fin = await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    expect(fin.body.status).toBe('READY');
    expect(fin.body.checksum).toMatch(/^[0-9a-f]{64}$/);
    await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    // no EXIF / geo fields in the API
    expect(JSON.stringify(fin.body)).not.toMatch(/exif|gps|latitude|longitude|storageKey/i);
  });

  it('oversize / wrong content → FAILED, cannot be attached, retry with a new intent does not duplicate posts', async () => {
    const u = await createUser(t);
    const created = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: 100,
    }).expect(201);
    const id = created.body.id as string;
    const res = await t
      .http()
      .put(`/v1/media/${id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/png')
      .send(pngBytes(500));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UPLOAD_FAILED');
    const asset = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe('FAILED');
    expect(asset.failureReason).toBe('SIZE_EXCEEDS_DECLARED');
    // no more content accepted, cannot finalize
    await t
      .http()
      .put(`/v1/media/${id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/png')
      .send(pngBytes(50))
      .expect(409);
    await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(422);
    // failed asset cannot be attached
    const post = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [id] });
    expect(post.status).toBe(400);
    expect(await t.prisma.post.count({ where: { authorId: u.userId } })).toBe(0);

    // wrong bytes for the declared mime
    const fake = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: 100,
    }).expect(201);
    const bad = await t
      .http()
      .put(`/v1/media/${fake.body.id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('MZ this is an exe'));
    expect(bad.status).toBe(422);
    expect(
      (await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id: fake.body.id } })).failureReason,
    ).toBe('CONTENT_TYPE_MISMATCH');

    // mime header mismatch
    const mm = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: 100,
    }).expect(201);
    await t
      .http()
      .put(`/v1/media/${mm.body.id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/jpeg')
      .send(pngBytes())
      .expect(422);

    // retry: a brand-new intent works and the eventual post exists exactly once
    const mediaId = await uploadPhoto(t, u);
    const key = `retry-${mediaId}`;
    for (let i = 0; i < 2; i++) {
      await t
        .http()
        .post('/v1/posts')
        .set(u.auth)
        .set('Idempotency-Key', key)
        .send({ text: 'retry', mediaIds: [mediaId] })
        .expect(201);
    }
    expect(await t.prisma.post.count({ where: { authorId: u.userId } })).toBe(1);
  });

  it('only the owner manages an asset; delete is soft and refused while attached', async () => {
    const u = await createUser(t);
    const other = await createUser(t);
    const id = await uploadPhoto(t, u);
    await t.http().get(`/v1/media/${id}`).set(other.auth).expect(404);
    await t.http().delete(`/v1/media/${id}`).set(other.auth).expect(404);
    await t.http().get(`/v1/media/${id}`).set(u.auth).expect(200);

    const post = await publishPost(t, u, { mediaIds: [id] });
    await t.http().delete(`/v1/media/${id}`).set(u.auth).expect(409);
    await t.http().delete(`/v1/posts/${post.id}`).set(u.auth).expect(204);
    await t.http().delete(`/v1/media/${id}`).set(u.auth).expect(204);
    await t.http().delete(`/v1/media/${id}`).set(u.auth).expect(204); // idempotent
    const list = await t.http().get('/v1/media').set(u.auth).expect(200);
    expect((list.body.items as { id: string }[]).some((m) => m.id === id)).toBe(false);
    // deleted media can never be attached again
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [id] })
      .expect(400);
  });

  it('signed URLs: access re-checked on every call, expire, tamper-proof', async () => {
    const owner = await createUser(t);
    const stranger = await createUser(t);
    const id = await uploadPhoto(t, owner);

    // private & unattached: only the owner
    await t.http().get(`/v1/media/${id}/url`).set(stranger.auth).expect(404);
    await t.http().get(`/v1/media/${id}/url`).expect(404);
    const own = await t.http().get(`/v1/media/${id}/url`).set(owner.auth).expect(200);
    const url = own.body.url as string;
    expect(new Date(own.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000 + 1000);

    const bytes = await t.http().get(url).expect(200);
    expect(bytes.headers['content-type']).toContain('image/png');
    expect(bytes.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(bytes.body).length).toBeGreaterThan(20);

    // tampering / other media id / garbage
    await t
      .http()
      // flip a character well inside the token: the last base64url char can carry unused bits
      .get(
        url.replace(
          /(.)(.{8})$/,
          (_m, c: string, tail: string) => `${c === 'A' ? 'B' : 'A'}${tail}`,
        ),
      )
      .expect(403);
    const other = await uploadPhoto(t, owner);
    const token = new URL(url, 'http://x').searchParams.get('token') as string;
    await t.http().get(`/v1/media/${other}/content?token=${token}`).expect(403);
    await t.http().get(`/v1/media/${id}/content?token=garbage`).expect(403);

    // expiry
    offsetMs = 301_000;
    await t.http().get(url).expect(410);
    offsetMs = 0;

    // attach to a followers-only post: viewer access follows the post audience, re-checked each call
    const viewer = await createUser(t);
    const post = await publishPost(t, owner, { mediaIds: [id], audience: 'FOLLOWERS' });
    await t.http().get(`/v1/media/${id}/url`).set(viewer.auth).expect(404);
    await t.prisma.follow.create({
      data: {
        followerId: viewer.userId,
        targetType: 'USER',
        targetId: owner.userId,
        status: 'ACCEPTED',
      },
    });
    const viaPost = await t.http().get(`/v1/media/${id}/url`).set(viewer.auth).expect(200);
    await t.http().get(viaPost.body.url).expect(200);
    // access revoked → next url call is refused (blocked)
    await block(t, owner, viewer);
    await t.http().get(`/v1/media/${id}/url`).set(viewer.auth).expect(404);
    // deleting the post removes viewer access too
    const v2 = await createUser(t);
    await t.prisma.follow.create({
      data: {
        followerId: v2.userId,
        targetType: 'USER',
        targetId: owner.userId,
        status: 'ACCEPTED',
      },
    });
    await t.http().get(`/v1/media/${id}/url`).set(v2.auth).expect(200);
    await t.http().delete(`/v1/posts/${post.id}`).set(owner.auth).expect(204);
    await t.http().get(`/v1/media/${id}/url`).set(v2.auth).expect(404);
  });

  it('PUBLIC media are reachable by visitors through a signed URL', async () => {
    const u = await createUser(t);
    const bytes = await realPng();
    const c = await intent(u.auth, {
      kind: 'PHOTO',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      visibility: 'PUBLIC',
    }).expect(201);
    await t
      .http()
      .put(`/v1/media/${c.body.id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/png')
      .send(bytes)
      .expect(200);
    await t.http().post(`/v1/media/${c.body.id}/finalize`).set(u.auth).send({}).expect(200);
    const res = await t.http().get(`/v1/media/${c.body.id}/url`).expect(200);
    await t.http().get(res.body.url).expect(200);
  });

  it('unfinished assets never get a url', async () => {
    const u = await createUser(t);
    const c = await intent(u.auth, { kind: 'PHOTO', mimeType: 'image/png', sizeBytes: 100 }).expect(
      201,
    );
    await t.http().get(`/v1/media/${c.body.id}/url`).set(u.auth).expect(404);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [c.body.id] })
      .expect(400);
  });
});
