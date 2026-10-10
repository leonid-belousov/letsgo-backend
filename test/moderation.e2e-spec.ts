import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import { makeStaff } from './support/results';

describe('moderation (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const post = (author: TestUser, audience: 'PUBLIC' | 'ONLY_ME' = 'PUBLIC') =>
    t.prisma.post.create({
      data: {
        authorId: author.userId,
        authorEntityId: author.userId,
        body: 'hello',
        status: 'PUBLISHED',
        audience,
        publishedAt: new Date(),
      },
    });
  const report = (who: TestUser, body: object, key?: string) => {
    const r = t.http().post('/v1/reports').set(who.auth);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };

  it('creates a receipt, dedupes identical open reports, requires visibility, never blocks or reveals the reporter', async () => {
    const author = await createUser(t);
    const reporter = await createUser(t);
    const p = await post(author);
    const body = { targetType: 'POST', targetId: p.id, reason: 'SPAM', text: 'looks like spam' };
    const r1 = await report(reporter, body).expect(200);
    expect(r1.body).toMatchObject({ status: 'OPEN', message: 'Report sent' });
    expect(typeof r1.body.ticketNumber).toBe('number');
    const [r2, r3] = await Promise.all([report(reporter, body), report(reporter, body)]);
    expect(r2.body.ticketNumber).toBe(r1.body.ticketNumber);
    expect(r3.body.ticketNumber).toBe(r1.body.ticketNumber);
    const other = await report(reporter, { ...body, reason: 'HARASSMENT' }).expect(200);
    expect(other.body.ticketNumber).not.toBe(r1.body.ticketNumber);
    expect(
      await t.prisma.report.count({ where: { reporterId: reporter.userId, targetId: p.id } }),
    ).toBe(2);

    // not visible ⇒ neutral NOT_FOUND; own content and bad input are rejected
    const secret = await post(author, 'ONLY_ME');
    await report(reporter, { targetType: 'POST', targetId: secret.id, reason: 'SPAM' }).expect(404);
    await report(author, body).expect(400);
    await report(reporter, { targetType: 'POST', targetId: p.id, reason: 'NOPE' }).expect(400);
    await report(reporter, {
      targetType: 'POST',
      targetId: p.id,
      reason: 'OTHER',
      text: 'x'.repeat(1001),
    }).expect(400);

    const mine = await t.http().get('/v1/reports/mine').set(reporter.auth).expect(200);
    expect(mine.body.items).toHaveLength(2);
    expect(Object.keys(mine.body.items[0]).sort()).toEqual([
      'createdAt',
      'reason',
      'status',
      'targetId',
      'targetType',
      'ticketNumber',
    ]);
    // the reported person sees nothing, and no block was created
    expect(
      (await t.http().get('/v1/reports/mine').set(author.auth).expect(200)).body.items,
    ).toHaveLength(0);
    expect(
      await t.prisma.block.count({
        where: { OR: [{ blockerId: reporter.userId }, { blockedId: reporter.userId }] },
      }),
    ).toBe(0);
  });

  it('staff permission is required; queue → take → hide post → resolve; author gets a neutral notice', async () => {
    const author = await createUser(t);
    const reporter = await createUser(t);
    const p = await post(author);
    const rep = await report(reporter, {
      targetType: 'POST',
      targetId: p.id,
      reason: 'INAPPROPRIATE',
    }).expect(200);
    const reportRow = await t.prisma.report.findFirstOrThrow({
      where: { ticketNumber: rep.body.ticketNumber },
    });
    await t.http().get('/v1/admin/reports').set(reporter.auth).expect(403);
    await t.http().post(`/v1/admin/reports/${reportRow.id}/take`).set(reporter.auth).expect(403);

    const mod = await makeStaff(t, ['admin.reports.moderate']);
    // the shared database holds reports from other suites: page until ours shows up
    let found = false;
    let cursor: string | null = null;
    for (let page = 0; page < 200 && !found; page++) {
      const q: string = `/v1/admin/reports?targetType=POST&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const queue = await t.http().get(q).set(mod.auth).expect(200);
      found = queue.body.items.some((i: { id: string }) => i.id === reportRow.id);
      cursor = queue.body.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(found).toBe(true);
    const taken = await t
      .http()
      .post(`/v1/admin/reports/${reportRow.id}/take`)
      .set(mod.auth)
      .expect(200);
    expect(taken.body.status).toBe('IN_REVIEW');
    const detail = await t
      .http()
      .get(`/v1/admin/reports/${reportRow.id}`)
      .set(mod.auth)
      .expect(200);
    expect(detail.body.target).toMatchObject({ exists: true, ownerId: author.userId });
    expect(
      await t.prisma.auditEvent.count({ where: { action: 'report.view', targetId: reportRow.id } }),
    ).toBe(1);

    const action = {
      reportId: reportRow.id,
      action: 'HIDE_POST',
      targetType: 'POST',
      targetId: p.id,
    };
    await t
      .http()
      .post('/v1/admin/moderation/actions')
      .set(mod.auth)
      .send({ ...action })
      .expect(400); // reason missing
    await t
      .http()
      .post('/v1/admin/moderation/actions')
      .set(mod.auth)
      .send({ ...action, reason: 'x', targetType: 'USER' })
      .expect(400);
    await t
      .http()
      .post('/v1/admin/moderation/actions')
      .set(mod.auth)
      .send({ ...action, reason: 'Violates guidelines' })
      .expect(200);
    const after = await t.prisma.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe('DELETED');
    expect(after.deletedAt).not.toBeNull();
    await t
      .http()
      .post('/v1/admin/moderation/actions')
      .set(mod.auth)
      .send({ ...action, reason: 'again' })
      .expect(409);
    expect(await t.prisma.moderationAction.count({ where: { targetId: p.id } })).toBe(1);

    // neutral notice: reaches the author, never mentions the reporter
    const notes = await t.prisma.notification.findMany({ where: { recipientId: author.userId } });
    const acts = await t.prisma.activityItem.findMany({ where: { recipientId: author.userId } });
    expect(notes.length).toBeGreaterThan(0);
    const dump = JSON.stringify([notes, acts]);
    expect(dump).not.toContain(reporter.userId);
    expect(acts.every((a) => a.actorId === null)).toBe(true);

    const done = await t
      .http()
      .post(`/v1/admin/reports/${reportRow.id}/resolve`)
      .set(mod.auth)
      .send({ resolution: 'Post removed' })
      .expect(200);
    expect(done.body.status).toBe('RESOLVED');
    await t
      .http()
      .post(`/v1/admin/reports/${reportRow.id}/dismiss`)
      .set(mod.auth)
      .send({ resolution: 'late' })
      .expect(409);
    const mine = await t.http().get('/v1/reports/mine').set(reporter.auth).expect(200);
    expect(mine.body.items[0].status).toBe('RESOLVED');
    expect(JSON.stringify(mine.body)).not.toContain(mod.userId);
  });

  it('remove comment / media, warn, suspend (revokes sessions) and restore', async () => {
    const author = await createUser(t);
    const mod = await makeStaff(t, ['admin.reports.moderate']);
    const p = await post(author);
    const c = await t.prisma.comment.create({
      data: { postId: p.id, authorId: author.userId, body: 'rude' },
    });
    const media = await t.prisma.mediaAsset.create({
      data: {
        ownerId: author.userId,
        kind: 'PHOTO',
        status: 'READY',
        visibility: 'PUBLIC',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        storageKey: `k-${author.userId}`,
      },
    });
    const act = (a: object) =>
      t
        .http()
        .post('/v1/admin/moderation/actions')
        .set(mod.auth)
        .send({ reason: 'policy', ...a });
    await act({ action: 'REMOVE_COMMENT', targetType: 'COMMENT', targetId: c.id }).expect(200);
    const cc = await t.prisma.comment.findUniqueOrThrow({ where: { id: c.id } });
    expect(cc.deletedAt).not.toBeNull();
    expect(cc.deletedById).toBe(mod.userId);
    await act({ action: 'REMOVE_MEDIA', targetType: 'MEDIA', targetId: media.id }).expect(200);
    expect(await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).toMatchObject({
      status: 'FAILED',
      failureReason: 'moderation',
    });
    await act({ action: 'WARN', targetType: 'USER', targetId: author.userId }).expect(200);

    await t.http().get('/v1/me').set(author.auth).expect(200);
    await act({ action: 'SUSPEND_USER', targetType: 'USER', targetId: mod.userId }).expect(400); // not yourself
    await act({ action: 'SUSPEND_USER', targetType: 'USER', targetId: author.userId }).expect(200);
    await t.http().get('/v1/me').set(author.auth).expect(401);
    expect(
      await t.prisma.session.count({ where: { userId: author.userId, revokedAt: null } }),
    ).toBe(0);
    await t
      .http()
      .post('/v1/auth/login')
      .send({ email: author.email, password: author.password })
      .expect(401);
    await act({ action: 'RESTORE_USER', targetType: 'USER', targetId: author.userId }).expect(200);
    await t
      .http()
      .post('/v1/auth/login')
      .send({ email: author.email, password: author.password })
      .expect(200);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'moderation.suspend_user', targetId: author.userId },
      }),
    ).toBe(1);
  });
});
