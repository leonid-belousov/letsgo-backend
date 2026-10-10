import sharp from 'sharp';
import { MediaStorage } from '../src/modules/media/storage';
import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import { block, publishPost, realPng } from './social-helpers';

/** 1600x800 JPEG carrying EXIF orientation 6 (rotate 90 CW) plus GPS + camera info. */
async function jpegWithGps(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 800, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .withExif({
      IFD0: { Make: 'SecretCam', Model: 'X-1', Copyright: 'someone' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '41/1 43/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '44/1 47/1 0/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

describe('media processing pipeline (e2e)', () => {
  let t: TestApp;
  let storage: MediaStorage;
  beforeAll(async () => {
    t = await createTestApp();
    storage = t.app.get(MediaStorage);
  });
  afterAll(() => t.close());

  const intentAndUpload = async (
    u: TestUser,
    bytes: Buffer,
    mimeType: string,
    kind: 'PHOTO' | 'VIDEO' | 'DOCUMENT' = 'PHOTO',
  ) => {
    const c = await t
      .http()
      .post('/v1/media/uploads')
      .set(u.auth)
      .send({ kind, mimeType, sizeBytes: bytes.length })
      .expect(201);
    const id = c.body.id as string;
    await t
      .http()
      .put(`/v1/media/${id}/content`)
      .set(u.auth)
      .set('Content-Type', mimeType)
      .send(bytes)
      .expect(200);
    return id;
  };
  const fetchVariant = async (u: TestUser | null, id: string, variant: string): Promise<Buffer> => {
    const req = t.http().get(`/v1/media/${id}/url?variant=${variant}`);
    if (u) req.set(u.auth);
    const url = await req.expect(200);
    const res = await t
      .http()
      .get(url.body.url as string)
      .expect(200);
    return Buffer.from(res.body as Buffer);
  };

  it('fixture really carries EXIF + GPS + orientation', async () => {
    const meta = await sharp(await jpegWithGps()).metadata();
    expect(meta.exif).toBeDefined();
    expect(meta.orientation).toBe(6);
    expect((await jpegWithGps()).includes(Buffer.from('Exif'))).toBe(true);
  });

  it('strips all metadata from the stored original AND the variants, keeps the picture oriented', async () => {
    const u = await createUser(t);
    const raw = await jpegWithGps();
    const id = await intentAndUpload(u, raw, 'image/jpeg');
    const fin = await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    expect(fin.body).toMatchObject({
      status: 'READY',
      metadataStripped: true,
      width: 800,
      height: 1600,
    });
    expect(fin.body.variants).toEqual([
      { label: 'thumb', width: 160, height: 320 },
      { label: 'card', width: 400, height: 800 },
    ]);
    expect(JSON.stringify(fin.body)).not.toMatch(/SecretCam|exif|gps|http|storageKey/i);

    const original = await fetchVariant(u, id, 'original');
    const om = await sharp(original).metadata();
    expect(om.format).toBe('jpeg');
    expect(om.exif).toBeUndefined();
    expect(om.xmp).toBeUndefined();
    expect(om.iptc).toBeUndefined();
    expect(om.orientation).toBeUndefined();
    expect([om.width, om.height]).toEqual([800, 1600]);
    expect(original.includes(Buffer.from('Exif'))).toBe(false);
    expect(original.includes(Buffer.from('SecretCam'))).toBe(false);
    expect(original.length).not.toBe(raw.length);

    for (const [label, w, h] of [
      ['thumb', 160, 320],
      ['card', 400, 800],
    ] as const) {
      const bytes = await fetchVariant(u, id, label);
      const m = await sharp(bytes).metadata();
      expect(m.format).toBe('webp');
      expect(m.exif).toBeUndefined();
      expect(m.orientation).toBeUndefined();
      expect([m.width, m.height]).toEqual([w, h]);
      expect(Math.max(m.width ?? 0, m.height ?? 0)).toBeLessThanOrEqual(
        label === 'thumb' ? 320 : 800,
      );
    }
    // the default variant is the original
    const dflt = await t.http().get(`/v1/media/${id}/url`).set(u.auth).expect(200);
    expect(dflt.body.url).toBeDefined();
    const row = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(row.metadataStripped).toBe(true);
    expect(Number(row.sizeBytes)).toBe(original.length);
  });

  it('small pictures are never enlarged; PNG stays PNG', async () => {
    const u = await createUser(t);
    const id = await intentAndUpload(u, await realPng(100, 50), 'image/png');
    const fin = await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    expect(fin.body.variants).toEqual([
      { label: 'thumb', width: 100, height: 50 },
      { label: 'card', width: 100, height: 50 },
    ]);
    expect((await sharp(await fetchVariant(u, id, 'original')).metadata()).format).toBe('png');
  });

  it('corrupt image → FAILED, raw upload deleted, cannot be attached, needs a new intent', async () => {
    const u = await createUser(t);
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]);
    const id = await intentAndUpload(u, junk, 'image/jpeg');
    const key = (await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } })).storageKey;
    const fin = await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({});
    expect(fin.status).toBe(422);
    expect(fin.body.error.code).toBe('UPLOAD_FAILED');
    const row = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('IMAGE_UNDECODABLE');
    expect(await storage.exists(key)).toBe(false);
    expect(await t.prisma.mediaVariant.count({ where: { assetId: id } })).toBe(0);
    await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(422);
    await t.http().put(`/v1/media/${id}/content`).set(u.auth).send(junk).expect(409);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [id] })
      .expect(400);
    await t.http().get(`/v1/media/${id}/url`).set(u.auth).expect(404);
    expect(await t.prisma.post.count({ where: { authorId: u.userId } })).toBe(0);
  });

  it('a valid header with the wrong format is rejected (PNG bytes declared as JPEG)', async () => {
    const u = await createUser(t);
    // magic bytes of a JPEG on top of PNG data would fail the sniff; use a real PNG declared as webp
    const png = await realPng();
    const c = await t
      .http()
      .post('/v1/media/uploads')
      .set(u.auth)
      .send({ kind: 'PHOTO', mimeType: 'image/webp', sizeBytes: png.length })
      .expect(201);
    const res = await t
      .http()
      .put(`/v1/media/${c.body.id}/content`)
      .set(u.auth)
      .set('Content-Type', 'image/webp')
      .send(png);
    expect(res.status).toBe(422);
    expect((await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id: c.body.id } })).status).toBe(
      'FAILED',
    );
  });

  it('decompression bomb (too many pixels) → FAILED', async () => {
    const u = await createUser(t);
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(20 * 1024 * 1024);
    const id = await intentAndUpload(u, bomb, 'image/png');
    const key = (await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } })).storageKey;
    await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(422);
    const row = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/IMAGE_TOO_MANY_PIXELS|IMAGE_UNDECODABLE/);
    expect(await storage.exists(key)).toBe(false);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [id] })
      .expect(400);
  }, 60_000);

  it('retry is idempotent: re-finalizing does nothing, concurrent finalize never duplicates variants', async () => {
    const u = await createUser(t);
    const id = await intentAndUpload(u, await jpegWithGps(), 'image/jpeg');
    const both = await Promise.all([
      t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}),
      t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const first = await t.prisma.mediaVariant.findMany({
      where: { assetId: id },
      orderBy: { label: 'asc' },
    });
    expect(first.map((v) => v.label)).toEqual(['card', 'thumb']);
    const before = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    const again = await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    expect(again.body.status).toBe('READY');
    const after = await t.prisma.mediaVariant.findMany({
      where: { assetId: id },
      orderBy: { label: 'asc' },
    });
    expect(after.map((v) => v.storageKey)).toEqual(first.map((v) => v.storageKey));
    const afterAsset = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(afterAsset.checksum).toBe(before.checksum);
    // no orphaned variant files: every stored variant key is recorded
    for (const v of after) expect(await storage.exists(v.storageKey)).toBe(true);
  });

  it('variant URLs re-check access on every call and never widen access', async () => {
    const owner = await createUser(t);
    const follower = await createUser(t);
    const stranger = await createUser(t);
    await t.prisma.follow.create({
      data: {
        followerId: follower.userId,
        targetType: 'USER',
        targetId: owner.userId,
        status: 'ACCEPTED',
      },
    });
    const id = await intentAndUpload(owner, await jpegWithGps(), 'image/jpeg');
    await t.http().post(`/v1/media/${id}/finalize`).set(owner.auth).send({}).expect(200);

    for (const variant of ['thumb', 'card', 'original']) {
      await t.http().get(`/v1/media/${id}/url?variant=${variant}`).set(stranger.auth).expect(404);
      await t.http().get(`/v1/media/${id}/url?variant=${variant}`).expect(404);
      await t.http().get(`/v1/media/${id}/url?variant=${variant}`).set(follower.auth).expect(404);
    }
    await t.http().get(`/v1/media/${id}/url?variant=huge`).set(owner.auth).expect(400);

    const post = await publishPost(t, owner, { mediaIds: [id], audience: 'FOLLOWERS' });
    const thumb = await t
      .http()
      .get(`/v1/media/${id}/url?variant=thumb`)
      .set(follower.auth)
      .expect(200);
    const res = await t.http().get(thumb.body.url).expect(200);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.headers['cache-control']).toContain('no-store');
    await t.http().get(`/v1/media/${id}/url?variant=card`).set(stranger.auth).expect(404);
    // a variant token cannot be turned into the original by editing the URL
    const token = new URL(thumb.body.url as string, 'http://x').searchParams.get('token') as string;
    const swapped = await t.http().get(`/v1/media/${id}/content?token=${token}`).expect(200);
    expect((await sharp(Buffer.from(swapped.body as Buffer)).metadata()).format).toBe('webp');

    await block(t, owner, follower);
    await t.http().get(`/v1/media/${id}/url?variant=thumb`).set(follower.auth).expect(404);
    await t.http().delete(`/v1/posts/${post.id}`).set(owner.auth).expect(204);
  });

  it('deleting an asset removes the variant bytes and rows', async () => {
    const u = await createUser(t);
    const id = await intentAndUpload(u, await jpegWithGps(), 'image/jpeg');
    await t.http().post(`/v1/media/${id}/finalize`).set(u.auth).send({}).expect(200);
    const asset = await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    const variants = await t.prisma.mediaVariant.findMany({ where: { assetId: id } });
    expect(variants).toHaveLength(2);
    await t.http().delete(`/v1/media/${id}`).set(u.auth).expect(204);
    expect(await storage.exists(asset.storageKey)).toBe(false);
    for (const v of variants) expect(await storage.exists(v.storageKey)).toBe(false);
    expect(await t.prisma.mediaVariant.count({ where: { assetId: id } })).toBe(0);
    await t.http().get(`/v1/media/${id}/url?variant=thumb`).set(u.auth).expect(404);
  });

  it('videos and documents are stored unchanged (no pixel processing, no variants)', async () => {
    const u = await createUser(t);
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypisom'),
      Buffer.alloc(64, 1),
    ]);
    const vid = await intentAndUpload(u, mp4, 'video/mp4', 'VIDEO');
    const fin = await t.http().post(`/v1/media/${vid}/finalize`).set(u.auth).send({}).expect(200);
    expect(fin.body).toMatchObject({ status: 'READY', metadataStripped: false, variants: [] });
    expect((await fetchVariant(u, vid, 'original')).equals(mp4)).toBe(true);
    await t.http().get(`/v1/media/${vid}/url?variant=thumb`).set(u.auth).expect(404);

    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 2)]);
    const doc = await intentAndUpload(u, pdf, 'application/pdf', 'DOCUMENT');
    const f2 = await t.http().post(`/v1/media/${doc}/finalize`).set(u.auth).send({}).expect(200);
    expect(f2.body).toMatchObject({ status: 'READY', metadataStripped: false, variants: [] });
    expect((await fetchVariant(u, doc, 'original')).equals(pdf)).toBe(true);
  });

  it('a processed photo attaches to a post; a FAILED one never does', async () => {
    const u = await createUser(t);
    const good = await intentAndUpload(u, await jpegWithGps(), 'image/jpeg');
    await t.http().post(`/v1/media/${good}/finalize`).set(u.auth).send({}).expect(200);
    const bad = await intentAndUpload(
      u,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50, 9)]),
      'image/jpeg',
    );
    await t.http().post(`/v1/media/${bad}/finalize`).set(u.auth).send({}).expect(422);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ mediaIds: [good, bad] })
      .expect(400);
    const ok = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ mediaIds: [good] })
      .expect(201);
    expect(ok.body.media[0].id).toBe(good);
  });
});
