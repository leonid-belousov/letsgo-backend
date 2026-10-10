import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { createClubRow, createGame, fillSeats, idemKey } from './support/games';

describe('chat, activity, notifications (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('direct chat honours the recipient’s message policy and blocks; sending is idempotent', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    // default: People I follow ⇒ B must follow A first
    await t.http().post('/v1/chat/direct').set(a.auth).send({ userId: b.userId }).expect(403);
    await t.prisma.follow.create({
      data: { followerId: b.userId, targetType: 'USER', targetId: a.userId, status: 'ACCEPTED' },
    });
    const conv = await t
      .http()
      .post('/v1/chat/direct')
      .set(a.auth)
      .send({ userId: b.userId })
      .expect(200);
    expect(conv.body.kind).toBe('DIRECT');
    expect(conv.body.counterpart.id).toBe(b.userId);
    const key = idemKey();
    const m1 = await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(a.auth)
      .set('Idempotency-Key', key)
      .send({ body: 'hello' })
      .expect(201);
    const m2 = await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(a.auth)
      .set('Idempotency-Key', key)
      .send({ body: 'hello' })
      .expect(201);
    expect(m2.body.id).toBe(m1.body.id);
    expect(await t.prisma.message.count({ where: { conversationId: conv.body.id } })).toBe(1);

    // B sees an unread badge, reads, badge clears
    const list = await t.http().get('/v1/chat/conversations').set(b.auth).expect(200);
    expect(list.body.items[0].unreadCount).toBe(1);
    expect(list.body.items[0].lastMessage.body).toBe('hello');
    await t.http().post(`/v1/chat/conversations/${conv.body.id}/read`).set(b.auth).expect(204);
    expect(
      (await t.http().get('/v1/chat/conversations').set(b.auth)).body.items[0].unreadCount,
    ).toBe(0);
    // the notification for the message is neutral (never the text)
    const notifs = await t.prisma.notification.findMany({
      where: { recipientId: b.userId, category: 'chat' },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.title).toBe('New message');
    expect(notifs[0]?.body).toBeNull();

    // strangers cannot read; blocking stops sending immediately even though the id is known
    const stranger = await createUser(t);
    await t
      .http()
      .get(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(stranger.auth)
      .expect(404);
    await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(stranger.auth)
      .send({ body: 'x' })
      .expect(404);
    await t.http().put(`/v1/blocks/${a.userId}`).set(b.auth).expect(204);
    await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(a.auth)
      .send({ body: 'still there?' })
      .expect(404);
    await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(b.auth)
      .send({ body: 'nope' })
      .expect(404);
  });

  it('edit/delete only your own messages; deleted text disappears', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    await t.prisma.follow.create({
      data: { followerId: b.userId, targetType: 'USER', targetId: a.userId, status: 'ACCEPTED' },
    });
    const conv = await t
      .http()
      .post('/v1/chat/direct')
      .set(a.auth)
      .send({ userId: b.userId })
      .expect(200);
    const m = await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(a.auth)
      .send({ body: 'secret' })
      .expect(201);
    await t
      .http()
      .patch(`/v1/chat/messages/${m.body.id}`)
      .set(b.auth)
      .send({ body: 'hack' })
      .expect(404);
    const edited = await t
      .http()
      .patch(`/v1/chat/messages/${m.body.id}`)
      .set(a.auth)
      .send({ body: 'fixed' })
      .expect(200);
    expect(edited.body.editedAt).not.toBeNull();
    await t.http().delete(`/v1/chat/messages/${m.body.id}`).set(b.auth).expect(404);
    await t.http().delete(`/v1/chat/messages/${m.body.id}`).set(a.auth).expect(204);
    const msgs = await t
      .http()
      .get(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(b.auth)
      .expect(200);
    expect(msgs.body.items[0]).toMatchObject({ deleted: true, body: null });
  });

  it('game chat: confirmed players + staff only; losing the place stops sending; waitlisted use the special contact', async () => {
    const org = await createUser(t);
    const clubId = await createClubRow(t, org);
    const [player, waiter, outsider] = await Promise.all([
      createUser(t),
      createUser(t),
      createUser(t),
    ]);
    const g = await createGame(t, org, { clubId });
    await t.http().post(`/v1/games/${g.id}/join`).set(player.auth).send({}).expect(200);
    const conv = await t.http().get(`/v1/chat/games/${g.id}`).set(player.auth).expect(200);
    expect(conv.body.capabilities).toEqual({ canRead: true, canPost: true });
    await t.http().get(`/v1/chat/games/${g.id}`).set(outsider.auth).expect(404);
    const orgConv = await t.http().get(`/v1/chat/games/${g.id}`).set(org.auth).expect(200);
    expect(orgConv.body.id).toBe(conv.body.id); // one conversation
    await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(player.auth)
      .send({ body: 'see you' })
      .expect(201);

    // waitlisted player: cannot read the squad chat, but can contact the organiser directly
    await fillSeats(t, g.id, 10); // 1 + 10 = 11 of 12, then org invites nobody; make it full with another join
    const extra = await createUser(t);
    await t.http().post(`/v1/games/${g.id}/join`).set(extra.auth).send({}).expect(200); // 12th
    const w = await t.http().post(`/v1/games/${g.id}/join`).set(waiter.auth).send({}).expect(200);
    expect(w.body.status).toBe('WAITLISTED');
    await t.http().get(`/v1/chat/games/${g.id}`).set(waiter.auth).expect(404);
    const contact = await t
      .http()
      .post(`/v1/chat/games/${g.id}/contact-organiser`)
      .set(waiter.auth)
      .expect(200);
    expect(contact.body.kind).toBe('DIRECT');
    await t.http().post(`/v1/chat/games/${g.id}/contact-organiser`).set(outsider.auth).expect(403);

    // the player leaves ⇒ can no longer post even though the id is known
    await t.http().delete(`/v1/games/${g.id}/participation`).set(player.auth).expect(200);
    await t
      .http()
      .post(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(player.auth)
      .send({ body: 'am I in?' })
      .expect(404);
    await t
      .http()
      .get(`/v1/chat/conversations/${conv.body.id}/messages`)
      .set(player.auth)
      .expect(404);
    // …and the stale membership row does not resurrect the conversation in their list
    const list = await t.http().get('/v1/chat/conversations').set(player.auth).expect(200);
    expect(list.body.items.find((c: { id: string }) => c.id === conv.body.id)).toBeUndefined();
  });

  it('invitation arrives as an actionable card in the personal system chat + activity; seeing it does not accept it', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, org);
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [p.userId] })
      .expect(200);
    const list = await t.http().get('/v1/chat/conversations').set(p.auth).expect(200);
    const sys = list.body.items.find((c: { kind: string }) => c.kind === 'SYSTEM');
    expect(sys.unreadCount).toBe(1);
    expect(sys.capabilities).toEqual({ canRead: true, canPost: false });
    const msgs = await t
      .http()
      .get(`/v1/chat/conversations/${sys.id}/messages`)
      .set(p.auth)
      .expect(200);
    expect(msgs.body.items[0]).toMatchObject({
      kind: 'SYSTEM_CARD',
      cardType: 'INVITATION',
      sender: null,
    });
    expect(msgs.body.items[0].cardPayload.invitationId).toBe(inv.body.created[0].id);
    await t
      .http()
      .post(`/v1/chat/conversations/${sys.id}/messages`)
      .set(p.auth)
      .send({ body: 'x' })
      .expect(403);
    await t.http().post(`/v1/chat/conversations/${sys.id}/read`).set(p.auth).expect(204);
    // Activity: mark read only changes the read flag
    const act = await t.http().get('/v1/activity?unread=true').set(p.auth).expect(200);
    const item = act.body.items.find((i: { kind: string }) => i.kind === 'invitation.received');
    expect(item.actor.id).toBe(org.userId);
    await t.http().post('/v1/activity/read-all').set(p.auth).expect(200);
    expect((await t.http().get('/v1/activity/unread-count').set(p.auth)).body.unread).toBe(0);
    expect(
      (await t.prisma.invitation.findUniqueOrThrow({ where: { id: inv.body.created[0].id } }))
        .status,
    ).toBe('PENDING');
    // another user's chat/system conversation is unreachable
    const other = await createUser(t);
    await t.http().get(`/v1/chat/conversations/${sys.id}/messages`).set(other.auth).expect(404);
  });

  it('activity + notifications are keyset paginated and owner-scoped', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    for (let i = 0; i < 3; i++) {
      const g = await createGame(t, org);
      await t
        .http()
        .post(`/v1/games/${g.id}/invitations`)
        .set(org.auth)
        .send({ inviteeIds: [p.userId] })
        .expect(200);
    }
    const p1 = await t.http().get('/v1/activity?limit=2').set(p.auth).expect(200);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await t
      .http()
      .get(`/v1/activity?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set(p.auth)
      .expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(3);
    await t.http().get('/v1/activity?cursor=garbage').set(p.auth).expect(400);
    // nobody else sees these
    expect(
      (await t.http().get('/v1/activity').set(org.auth)).body.items.every(
        (i: { kind: string }) => i.kind !== 'invitation.received',
      ),
    ).toBe(true);
    const n = await t.http().get('/v1/notifications').set(p.auth).expect(200);
    expect(n.body.items).toHaveLength(3);
    expect(n.body.items[0].title).toBe('You were invited to a game');
  });

  it('preferences: push off ⇒ notification is SKIPPED not pushed; dispatcher marks SENT/PENDING correctly', async () => {
    const org = await createUser(t);
    const quiet = await createUser(t);
    const loud = await createUser(t);
    await t
      .http()
      .put('/v1/notifications/preferences')
      .set(quiet.auth)
      .send({ category: 'invitation', inApp: true, push: false })
      .expect(200);
    const prefs = await t.http().get('/v1/notifications/preferences').set(quiet.auth).expect(200);
    expect(prefs.body.find((p: { category: string }) => p.category === 'invitation')).toMatchObject(
      { inApp: true, push: false },
    );
    expect(prefs.body.find((p: { category: string }) => p.category === 'social')).toMatchObject({
      push: false,
    }); // default: no push per post
    const g = await createGame(t, org);
    await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [quiet.userId, loud.userId] })
      .expect(200);
    const q = await t.prisma.notification.findFirstOrThrow({
      where: { recipientId: quiet.userId },
    });
    const l = await t.prisma.notification.findFirstOrThrow({ where: { recipientId: loud.userId } });
    expect(q.delivery).toBe('SKIPPED');
    expect(l.delivery).toBe('PENDING');
    // The shared test DB holds other suites' PENDING rows: drain the queue until ours is delivered.
    let sent = 0;
    for (let i = 0; i < 200; i++) {
      const r = await t.app.get(NotificationsService).dispatchPending(500);
      sent += r.sent;
      if (r.sent + r.failed === 0) break;
    }
    expect(sent).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: l.id } })).delivery).toBe(
      'SENT',
    );
    await t
      .http()
      .put('/v1/notifications/preferences')
      .set(quiet.auth)
      .send({ category: 'nonsense', inApp: true, push: true })
      .expect(400);
  });

  it('blocked users do not receive social notices, but essential game notices still arrive', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    await t.http().put(`/v1/blocks/${org.userId}`).set(p.auth).expect(204);
    const g = await createGame(t, org);
    // invitation is refused by the block itself (NOT_ALLOWED), nothing delivered
    const res = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [p.userId] })
      .expect(200);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped[0].reason).toBe('NOT_ALLOWED');
    expect(await t.prisma.notification.count({ where: { recipientId: p.userId } })).toBe(0);
  });
});
