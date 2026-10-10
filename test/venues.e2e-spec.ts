import { createPitch, grantVia, makeStaff } from './bookings.support';
import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq, type TestUser } from './support/factories';

describe('venues (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const api = (
    u: TestUser,
    method: 'post' | 'get' | 'put' | 'delete' | 'patch',
    path: string,
    body?: object,
  ) => {
    const r = t.http()[method](path).set(u.auth);
    return body ? r.send(body) : r;
  };

  async function photo(u: TestUser, over: Record<string, unknown> = {}): Promise<string> {
    const a = await t.prisma.mediaAsset.create({
      data: {
        ownerId: u.userId,
        kind: 'PHOTO',
        status: 'READY',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        storageKey: `test/${uniq(16)}`,
        ...over,
      },
    });
    return a.id;
  }

  describe('catalog', () => {
    it('drafts are invisible to the public; published venues are visible to visitors without private data', async () => {
      const admin = await makeStaff(t, 'admin.catalog.manage');
      const visitor = await createUser(t);
      const city = `Cat${uniq(6)}`;
      const created = await api(admin, 'post', '/v1/venues', {
        name: 'Draft Arena',
        city,
        address: 'Rustaveli 1',
        latitude: 41.7,
        longitude: 44.8,
        about: 'Nice',
      }).expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({
        kind: 'PAID',
        status: 'DRAFT',
        timezone: 'Asia/Tbilisi',
        latitude: 41.7,
        version: 1,
        capabilities: { canEdit: true, canPublish: true },
      });

      await t.http().get(`/v1/venues/${id}`).expect(404);
      await api(visitor, 'get', `/v1/venues/${id}`).expect(404);
      const listBefore = await t.http().get(`/v1/venues?city=${city}`).expect(200);
      expect(listBefore.body.items).toHaveLength(0);
      // staff see it in their managed list and detail
      await api(admin, 'get', `/v1/venues/${id}`).expect(200);
      const managed = await api(admin, 'get', '/v1/venues/managed').expect(200);
      expect(managed.body.items.map((v: { id: string }) => v.id)).toContain(id);
      await api(visitor, 'get', '/v1/venues/managed').expect(200);

      await api(visitor, 'post', `/v1/venues/${id}/publish`).expect(404);
      await api(admin, 'post', `/v1/venues/${id}/publish`).expect(200);
      const pub = await t.http().get(`/v1/venues/${id}`).expect(200);
      expect(pub.body).toMatchObject({
        name: 'Draft Arena',
        status: 'PUBLISHED',
        capabilities: { canEdit: false },
      });
      expect(pub.body).not.toHaveProperty('version');
      const text = JSON.stringify(pub.body);
      expect(text).not.toMatch(/createdById|staffNote|externalPhone|phone|email/i);
      expect(text).not.toContain(admin.userId);
      const list = await t.http().get(`/v1/venues?city=${city.toLowerCase()}`).expect(200);
      expect(list.body.items.map((v: { id: string }) => v.id)).toEqual([id]);
      await api(admin, 'post', `/v1/venues/${id}/hide`).expect(200);
      await t.http().get(`/v1/venues/${id}`).expect(404);
    });

    it('search filters (city, q, kind, surface, setting, format) and keyset pagination', async () => {
      const admin = await makeStaff(t, 'admin.catalog.manage');
      const city = `Filt${uniq(6)}`;
      const mk = async (name: string, pitch: object) => {
        const f = await createPitch(t, { admin, city });
        const v = await api(admin, 'get', `/v1/venues/${f.venueId}`).expect(200);
        await api(admin, 'patch', `/v1/venues/${f.venueId}`, {
          name,
          version: v.body.version,
        }).expect(200);
        const p = await api(admin, 'get', `/v1/pitches/${f.pitchId}`).expect(200);
        await api(admin, 'patch', `/v1/pitches/${f.pitchId}`, {
          ...pitch,
          version: p.body.version,
        }).expect(200);
        return f;
      };
      const tag = uniq(6);
      const a = await mk(`Alpha ${tag}`, {
        surface: 'NATURAL',
        setting: 'OUTDOOR',
        formats: ['11v11'],
      });
      const b = await mk(`Beta ${tag}`, {
        surface: 'ARTIFICIAL',
        setting: 'INDOOR',
        formats: ['5v5', '6v6'],
      });
      const c = await mk(`Gamma ${tag}`, {
        surface: 'ARTIFICIAL',
        setting: 'OUTDOOR',
        formats: ['7v7'],
      });
      const ids = (r: { body: { items: { id: string }[] } }) =>
        r.body.items.map((x) => x.id).sort();
      const get = (qs: string) => t.http().get(`/v1/venues?city=${city}&${qs}`).expect(200);

      expect(ids(await get(''))).toEqual([a.venueId, b.venueId, c.venueId].sort());
      expect(ids(await get(`q=beta`))).toEqual([b.venueId]);
      expect(ids(await get('surface=ARTIFICIAL'))).toEqual([b.venueId, c.venueId].sort());
      expect(ids(await get('setting=INDOOR'))).toEqual([b.venueId]);
      expect(ids(await get('format=7v7'))).toEqual([c.venueId]);
      expect(ids(await get('surface=ARTIFICIAL&setting=OUTDOOR'))).toEqual([c.venueId]);
      expect(ids(await get('kind=COMMUNITY'))).toEqual([]);
      await t.http().get(`/v1/venues?surface=MARBLE`).expect(400);

      const p1 = await get('limit=2');
      expect(p1.body.items).toHaveLength(2);
      const p2 = await t
        .http()
        .get(`/v1/venues?city=${city}&limit=2&cursor=${p1.body.nextCursor}`)
        .expect(200);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(3);
    });

    it('pitch detail exposes surface, setting, size, formats, price, rules and latest terms', async () => {
      const f = await createPitch(t, { terms: 'Free cancellation until 24h.' });
      const admin = f.admin;
      const p = await api(admin, 'get', `/v1/pitches/${f.pitchId}`).expect(200);
      await api(admin, 'patch', `/v1/pitches/${f.pitchId}`, {
        lengthM: 40,
        widthM: 20.5,
        amenities: ['showers', 'parking'],
        version: p.body.version,
      }).expect(200);
      const pub = await t.http().get(`/v1/pitches/${f.pitchId}`).expect(200);
      expect(pub.body).toMatchObject({
        name: 'Pitch 1',
        surface: 'ARTIFICIAL',
        setting: 'OUTDOOR',
        lengthM: 40,
        widthM: 20.5,
        formats: ['5v5', '7v7'],
        amenities: ['showers', 'parking'],
        pricePerHourMinor: 6000,
        currency: 'GEL',
        bookable: true,
        latestTerms: { version: 1, body: 'Free cancellation until 24h.' },
        bookingRules: {
          minDurationMinutes: 60,
          gridMinutes: 30,
          allowHalfHourExtension: false,
          stepMinutes: 60,
        },
        capabilities: { canEdit: false, canManageBookings: false },
      });
      expect(pub.body).not.toHaveProperty('version');
      const venue = await t.http().get(`/v1/venues/${f.venueId}`).expect(200);
      expect(venue.body.pitches).toHaveLength(1);
      expect(venue.body.pitchCount).toBe(1);
    });
  });

  describe('management', () => {
    it('only catalog staff create venues; managers and outsiders are checked per object', async () => {
      const f = await createPitch(t);
      const other = await createPitch(t);
      const outsider = await createUser(t);
      const mgr = await createUser(t);

      await api(outsider, 'post', '/v1/venues', { name: 'Nope', city: 'X' }).expect(403);
      await api(outsider, 'patch', `/v1/venues/${f.venueId}`, { name: 'Hack', version: 1 }).expect(
        403,
      );
      await api(outsider, 'patch', `/v1/pitches/${f.pitchId}`, { name: 'Hack', version: 1 }).expect(
        403,
      );
      await api(outsider, 'post', `/v1/venues/${f.venueId}/pitches`, { name: 'Hack' }).expect(403);

      // manager = pitch.manage granted through the real grants API on the venue
      await grantVia(t, f.admin, mgr, 'VENUE', f.venueId, 'pitch.manage').then((r) =>
        expect(r.status).toBe(201),
      );
      const v = await api(mgr, 'get', `/v1/venues/${f.venueId}`).expect(200);
      expect(v.body.capabilities).toMatchObject({ canEdit: true, canPublish: false });
      const upd = await api(mgr, 'patch', `/v1/venues/${f.venueId}`, {
        about: 'New about',
        version: v.body.version,
      }).expect(200);
      expect(upd.body.version).toBe(v.body.version + 1);
      const stale = await api(mgr, 'patch', `/v1/venues/${f.venueId}`, {
        about: 'x',
        version: v.body.version,
      }).expect(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CHANGED',
        details: { currentVersion: v.body.version + 1 },
      });
      await api(mgr, 'post', `/v1/venues/${f.venueId}/hide`).expect(403); // needs venue.manage / staff
      await api(mgr, 'post', `/v1/venues/${f.venueId}/pitches`, { name: 'Pitch 2' }).expect(201);
      // …but nothing on another venue
      await api(mgr, 'patch', `/v1/venues/${other.venueId}`, { about: 'x', version: 1 }).expect(
        403,
      );
      await api(mgr, 'patch', `/v1/pitches/${other.pitchId}`, { name: 'x', version: 1 }).expect(
        403,
      );

      // pitch-level grant only reaches that pitch
      const pm = await createUser(t);
      await grantVia(t, f.admin, pm, 'PITCH', f.pitchId, 'pitch.manage').then((r) =>
        expect(r.status).toBe(201),
      );
      const p = await api(pm, 'get', `/v1/pitches/${f.pitchId}`).expect(200);
      await api(pm, 'patch', `/v1/pitches/${f.pitchId}`, {
        name: 'Renamed',
        version: p.body.version,
      }).expect(200);
      await api(pm, 'patch', `/v1/venues/${f.venueId}`, { about: 'x', version: 99 }).expect(403);
      // audit trail
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'venue.update', targetId: f.venueId, actorId: mgr.userId },
        }),
      ).toBe(1);
      expect(
        await t.prisma.auditEvent.count({ where: { action: 'venue.create', targetId: f.venueId } }),
      ).toBe(1);
    });

    it('new pitches always have a part and a “Whole pitch” configuration covering all parts', async () => {
      const f = await createPitch(t);
      const single = await api(f.admin, 'get', `/v1/pitches/${f.pitchId}`).expect(200);
      expect(single.body.parts).toHaveLength(1);
      expect(single.body.configurations).toHaveLength(1);
      expect(single.body.configurations[0]).toMatchObject({
        name: 'Whole pitch',
        partIds: [single.body.parts[0].id],
      });
      expect(single.body.bookingRules).toMatchObject({ minDurationMinutes: 60, gridMinutes: 30 });

      const quarters = await api(f.admin, 'post', `/v1/venues/${f.venueId}/pitches`, {
        name: 'Big',
        partNames: ['A', 'B', 'C', 'D'],
      }).expect(201);
      expect(quarters.body.status).toBe('DRAFT');
      expect(quarters.body.parts).toHaveLength(4);
      const whole = quarters.body.configurations.find(
        (c: { name: string }) => c.name === 'Whole pitch',
      );
      expect(whole.partIds).toHaveLength(4);
      await api(f.admin, 'post', `/v1/venues/${f.venueId}/pitches`, {
        name: 'Bad',
        partNames: [],
      }).expect(400);
    });

    it('parts and configurations: uniqueness, protection of the default, no silent invalidation', async () => {
      const f = await createPitch(t, { quarters: true });
      const pitch = (await api(f.admin, 'get', `/v1/pitches/${f.pitchId}`).expect(200)).body;
      expect(pitch.configurations).toHaveLength(7);
      const [q1] = pitch.parts as { id: string }[];

      // duplicates & unknown parts
      await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/configurations`, {
        name: 'half a',
        partIds: [q1?.id],
      }).expect(409);
      await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/configurations`, {
        name: 'Alien',
        partIds: ['0190a0a0-0000-7000-8000-000000000000'],
      }).expect(400);
      // the default configuration is fixed
      await api(f.admin, 'patch', `/v1/pitches/${f.pitchId}/configurations/${f.wholeId}`, {
        name: 'Renamed',
      }).expect(409);
      await api(f.admin, 'delete', `/v1/pitches/${f.pitchId}/configurations/${f.wholeId}`).expect(
        409,
      );
      // adding a part extends the default configuration
      const grown = await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/parts`, {
        name: 'Q5',
      }).expect(201);
      const whole = grown.body.configurations.find(
        (c: { name: string }) => c.name === 'Whole pitch',
      );
      expect(whole.partIds).toHaveLength(5);
      // a part with history cannot be removed; an unused one can
      const cal = await createUser(t);
      await grantVia(t, f.admin, cal, 'VENUE', f.venueId, 'pitch.calendar.manage').then((r) =>
        expect(r.status).toBe(201),
      );
      const start = new Date(Date.now() + 5 * 86_400_000);
      start.setUTCMinutes(0, 0, 0);
      const block = await api(cal, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        configurationId: f.configs['Q1'],
        startsAt: start.toISOString(),
        durationMinutes: 30,
      }).expect(201);
      expect(block.body.id).toBeDefined();
      await api(f.admin, 'delete', `/v1/pitches/${f.pitchId}/parts/${q1?.id}`).expect(409);
      const q5 = grown.body.parts.find((p: { name: string }) => p.name === 'Q5');
      const shrunk = await api(f.admin, 'delete', `/v1/pitches/${f.pitchId}/parts/${q5.id}`).expect(
        200,
      );
      expect(shrunk.body.parts).toHaveLength(4);
      // repartitioning a configuration with upcoming bookings is refused
      const booker = await createUser(t);
      const later = new Date(start.getTime() + 86_400_000);
      later.setUTCHours(14, 0, 0, 0); // 18:00 Tbilisi
      await api(booker, 'post', '/v1/bookings', {
        pitchId: f.pitchId,
        configurationId: f.configs['Half A'],
        startsAt: later.toISOString(),
        durationMinutes: 60,
      }).expect(201);
      await api(
        f.admin,
        'patch',
        `/v1/pitches/${f.pitchId}/configurations/${f.configs['Half A']}`,
        {
          partIds: [q1?.id],
        },
      ).expect(409);
      await api(
        f.admin,
        'delete',
        `/v1/pitches/${f.pitchId}/configurations/${f.configs['Half A']}`,
      ).expect(409);
      // format tweak is harmless; an unused configuration can go
      await api(
        f.admin,
        'patch',
        `/v1/pitches/${f.pitchId}/configurations/${f.configs['Half A']}`,
        { format: '5v5' },
      ).expect(200);
      await api(
        f.admin,
        'delete',
        `/v1/pitches/${f.pitchId}/configurations/${f.configs['Q4']}`,
      ).expect(200);
      // a pitch keeps at least one part
      const single = await createPitch(t, { admin: f.admin });
      const sp = (await api(f.admin, 'get', `/v1/pitches/${single.pitchId}`).expect(200)).body;
      await api(f.admin, 'delete', `/v1/pitches/${single.pitchId}/parts/${sp.parts[0].id}`).expect(
        409,
      );
    });

    it('booking rules: validated, versioned on every change; terms are append-only', async () => {
      const f = await createPitch(t);
      const rulesPath = `/v1/pitches/${f.pitchId}/booking-rules`;
      const get = async () =>
        (await t.http().get(`/v1/pitches/${f.pitchId}`).expect(200)).body.bookingRules;
      const v0 = (await get()).ruleVersion as number;
      const bad = async (body: object) => api(f.admin, 'put', rulesPath, body).expect(400);
      await bad({ openingHours: { funday: [{ open: '09:00', close: '18:00' }] } });
      await bad({ openingHours: { mon: [{ open: '9am', close: '18:00' }] } });
      await bad({ openingHours: { mon: [{ open: '09:00', close: '09:00' }] } });
      await bad({
        openingHours: {
          mon: [
            { open: '09:00', close: '12:00' },
            { open: '11:00', close: '14:00' },
          ],
        },
      });
      await bad({ openingHours: [] });
      await bad({ minDurationMinutes: 45 }); // not on the 30-minute grid
      await bad({ gridMinutes: 20 });
      await bad({ minDurationMinutes: 10 });
      expect((await get()).ruleVersion).toBe(v0);

      const ok = await api(f.admin, 'put', rulesPath, {
        minDurationMinutes: 90,
        allowHalfHourExtension: true,
        openingHours: { mon: [{ open: '09:00', close: '01:00' }], tue: [] },
      }).expect(200);
      expect(ok.body.bookingRules).toMatchObject({
        minDurationMinutes: 90,
        allowHalfHourExtension: true,
        stepMinutes: 30,
        ruleVersion: v0 + 1,
        openingHours: { mon: [{ open: '09:00', close: '01:00' }], tue: [] },
      });
      await api(f.admin, 'put', rulesPath, { expectedRuleVersion: v0 }).expect(409);
      const cleared = await api(f.admin, 'put', rulesPath, {
        openingHours: null,
        expectedRuleVersion: v0 + 1,
      }).expect(200);
      expect(cleared.body.bookingRules.openingHours).toBeNull();
      expect(cleared.body.bookingRules.ruleVersion).toBe(v0 + 2);
      await api(await createUser(t), 'put', rulesPath, { minDurationMinutes: 60 }).expect(403);

      // terms
      const t1 = await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/terms`, {
        body: 'v1',
      }).expect(201);
      const t2 = await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/terms`, {
        body: 'v2',
      }).expect(201);
      expect([t1.body.version, t2.body.version]).toEqual([1, 2]);
      await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/terms`, { body: '  ' }).expect(400);
      await api(await createUser(t), 'post', `/v1/pitches/${f.pitchId}/terms`, {
        body: 'x',
      }).expect(403);
      const rows = await t.prisma.bookingTerms.findMany({
        where: { pitchId: f.pitchId },
        orderBy: { version: 'asc' },
      });
      expect(rows.map((r) => r.body)).toEqual(['v1', 'v2']);
      await api(await createUser(t), 'get', `/v1/pitches/${f.pitchId}/terms`).expect(403);
    });
  });

  describe('community pitch', () => {
    const body = (photoMediaIds: string[], over: Record<string, unknown> = {}) => ({
      name: `Yard ${uniq(6)}`,
      city: `Town${uniq(6)}`,
      latitude: 20 + Math.random() * 40, // random so runs never collide with old data
      longitude: -100 + Math.random() * 200,
      photoMediaIds,
      confirmedFreePublic: true,
      ...over,
    });

    it('published at once as COMMUNITY; contributor is not owner/manager; not bookable', async () => {
      const u = await createUser(t);
      const admin = await makeStaff(t, 'admin.catalog.manage');
      const p = await photo(u);
      const payload = body([p], { surface: 'HARD_COURT', setting: 'OUTDOOR' });
      const res = await api(u, 'post', '/v1/venues/community', payload).expect(201);
      expect(res.body).toMatchObject({ created: true, duplicateOf: null });
      const v = res.body.venue;
      expect(v).toMatchObject({
        kind: 'COMMUNITY',
        status: 'PUBLISHED',
        photoMediaIds: [p],
        capabilities: { canEdit: false, canPublish: false },
      });
      expect(v.pitches).toHaveLength(1);
      expect(v.pitches[0]).toMatchObject({
        bookable: false,
        surface: 'HARD_COURT',
        status: 'PUBLISHED',
      });
      const row = await t.prisma.venue.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.createdById).toBe(u.userId);
      expect(await t.prisma.roleGrant.count({ where: { granteeId: u.userId } })).toBe(0);
      expect((await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id: p } })).visibility).toBe(
        'PUBLIC',
      );
      // visible to visitors, editable only through staff
      await t.http().get(`/v1/venues/${v.id}`).expect(200);
      await t.http().get(`/v1/venues?kind=COMMUNITY&city=${payload.city}`).expect(200);
      await api(u, 'patch', `/v1/venues/${v.id}`, { name: 'Mine now', version: 1 }).expect(403);
      await api(u, 'post', `/v1/venues/${v.id}/hide`).expect(403);
      await api(admin, 'patch', `/v1/venues/${v.id}`, {
        about: 'Fixed by staff',
        version: 1,
      }).expect(200);
      // bookings are for paid pitches only
      const booker = await createUser(t);
      const pitch = v.pitches[0];
      await api(booker, 'post', '/v1/bookings', {
        pitchId: pitch.id,
        configurationId: pitch.configurations[0].id,
        startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        durationMinutes: 60,
      }).expect(400);
    });

    it('validation: confirmation flag, ≥ 1 own READY photo, complete profile', async () => {
      const u = await createUser(t);
      const other = await createUser(t);
      const mine = await photo(u);
      const foreign = await photo(other);
      const processing = await photo(u, { status: 'PROCESSING' });
      const video = await photo(u, { kind: 'VIDEO' });
      await api(
        u,
        'post',
        '/v1/venues/community',
        body([mine], { confirmedFreePublic: false }),
      ).expect(400);
      await api(u, 'post', '/v1/venues/community', body([])).expect(400);
      await api(u, 'post', '/v1/venues/community', body([foreign])).expect(400);
      await api(u, 'post', '/v1/venues/community', body([processing])).expect(400);
      await api(u, 'post', '/v1/venues/community', body([video])).expect(400);
      await api(
        u,
        'post',
        '/v1/venues/community',
        body(['0190a0a0-0000-7000-8000-000000000000']),
      ).expect(400);
      await api(u, 'post', '/v1/venues/community', body([mine], { latitude: 123 })).expect(400);
      await api(u, 'post', '/v1/venues/community', body([mine], { timezone: 'Mars/Base' })).expect(
        400,
      );
      await api(u, 'post', '/v1/venues/community', { ...body([mine]), extra: 1 }).expect(400);
      const incomplete = await createUser(t, { complete: false });
      await api(incomplete, 'post', '/v1/venues/community', body([await photo(incomplete)])).expect(
        400,
      );
      await t
        .http()
        .post('/v1/venues/community')
        .send(body([mine]))
        .expect(401);
    });

    it('a duplicate (same name+city, or within ~50 m) returns the existing venue with 200', async () => {
      const a = await createUser(t);
      const b = await createUser(t);
      const first = body([await photo(a)], { name: `Corner Pitch ${uniq(6)}` });
      const created = await api(a, 'post', '/v1/venues/community', first).expect(201);
      const id = created.body.venue.id as string;

      const sameName = await api(b, 'post', '/v1/venues/community', {
        ...body([await photo(b)]),
        name: (first.name as string).toUpperCase(),
        city: (first.city as string).toLowerCase(),
        latitude: 42.5,
        longitude: 45.5,
      }).expect(200);
      expect(sameName.body).toMatchObject({ created: false, duplicateOf: id });
      expect(sameName.body.venue.id).toBe(id);

      // ~30 m away, different name
      const near = await api(b, 'post', '/v1/venues/community', {
        ...body([await photo(b)]),
        city: `Other${uniq(4)}`,
        latitude: (first.latitude as number) + 0.00027,
        longitude: first.longitude,
      }).expect(200);
      expect(near.body).toMatchObject({ created: false, duplicateOf: id });
      // ~300 m away is a different pitch
      await api(b, 'post', '/v1/venues/community', {
        ...body([await photo(b)]),
        city: `Other${uniq(4)}`,
        latitude: (first.latitude as number) + 0.0027,
        longitude: first.longitude,
      }).expect(201);
      expect(await t.prisma.venue.count({ where: { name: first.name as string } })).toBe(1);
    });

    it('identical parallel submissions create exactly one venue; a key makes retries safe', async () => {
      const users = await Promise.all([createUser(t), createUser(t), createUser(t)]);
      const shared = { name: `Race Pitch ${uniq(6)}`, city: `Race${uniq(6)}` };
      const results = await Promise.all(
        await Promise.all(
          users.map(async (u) =>
            api(u, 'post', '/v1/venues/community', body([await photo(u)], shared)),
          ),
        ),
      );
      const created = results.filter((r) => r.status === 201);
      const dup = results.filter((r) => r.status === 200);
      expect(created).toHaveLength(1);
      expect(dup).toHaveLength(2);
      for (const d of dup) expect(d.body.duplicateOf).toBe(created[0]?.body.venue.id);
      expect(await t.prisma.venue.count({ where: { name: shared.name, city: shared.city } })).toBe(
        1,
      );

      const u = await createUser(t);
      const payload = body([await photo(u)]);
      const key = `cm-${uniq(12)}`;
      const send = () =>
        t.http().post('/v1/venues/community').set(u.auth).set('Idempotency-Key', key).send(payload);
      const [x, y] = await Promise.all([send(), send()]);
      expect(x.body.venue.id).toBe(y.body.venue.id);
      expect(x.body.created).toBe(true);
    });
  });

  describe('paid pitch requests', () => {
    it('request → staff asks for more info → user answers → staff approves (draft) → staff publishes', async () => {
      const u = await createUser(t);
      const staff = await makeStaff(t, 'admin.venueRequests.review');
      const catalog = await makeStaff(t, 'admin.catalog.manage');
      const p1 = await photo(u);
      const city = `Paid${uniq(6)}`;
      const created = await api(u, 'post', '/v1/venue-requests', {
        name: 'Big Dome',
        city,
        address: 'Somewhere 5',
        photoMediaIds: [p1],
        comment: 'Indoor 7v7, 3 pitches',
      }).expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({
        status: 'PENDING',
        from: 'Let’sGo',
        message: null,
        venueId: null,
      });

      // validation
      await api(u, 'post', '/v1/venue-requests', {
        name: 'x',
        city: 'y',
        photoMediaIds: [p1],
      }).expect(400); // no address/point
      await api(u, 'post', '/v1/venue-requests', {
        name: 'x',
        city: 'y',
        address: 'a',
        photoMediaIds: [],
      }).expect(400);
      await api(u, 'post', '/v1/venue-requests', {
        name: 'x',
        city: 'y',
        address: 'a',
        photoMediaIds: [await photo(staff)],
      }).expect(400);
      await api(u, 'post', '/v1/venue-requests', {
        name: 'x',
        city: 'y',
        latitude: 41.7,
        photoMediaIds: [p1],
      }).expect(400);
      await api(u, 'post', '/v1/venue-requests', {
        name: 'x',
        city: 'y',
        latitude: 41.7,
        longitude: 44.8,
        photoMediaIds: [p1],
      }).expect(201);

      // staff endpoints are permission-gated
      await api(u, 'get', '/v1/admin/venue-requests').expect(403);
      await api(u, 'post', `/v1/admin/venue-requests/${id}/approve`, {}).expect(403);
      await api(catalog, 'get', '/v1/admin/venue-requests').expect(403);
      const queue = await api(
        staff,
        'get',
        '/v1/admin/venue-requests?status=PENDING&limit=100',
      ).expect(200);
      const item = queue.body.items.find((r: { id: string }) => r.id === id);
      expect(item).toMatchObject({
        requestedById: u.userId,
        requesterUsername: u.username,
        status: 'PENDING',
      });

      const info = await api(staff, 'post', `/v1/admin/venue-requests/${id}/request-info`, {
        message: 'Please add the opening hours.',
      }).expect(200);
      expect(info.body.status).toBe('NEEDS_INFO');
      const mine = await api(u, 'get', `/v1/venue-requests/${id}`).expect(200);
      expect(mine.body).toMatchObject({
        status: 'NEEDS_INFO',
        from: 'Let’sGo',
        message: 'Please add the opening hours.',
      });
      // the requester never learns who reviewed it
      expect(JSON.stringify(mine.body)).not.toMatch(
        new RegExp(`${staff.userId}|reviewer|reviewedBy`, 'i'),
      );
      expect(mine.body).not.toHaveProperty('reviewedById');
      await api(u, 'post', `/v1/venue-requests/${id}/respond`, {
        comment: 'Open 10:00–23:00 daily',
      }).expect(200);
      await api(u, 'post', `/v1/venue-requests/${id}/respond`, { comment: 'again' }).expect(409); // nothing asked now
      await api(await createUser(t), 'get', `/v1/venue-requests/${id}`).expect(404);
      const list = await api(u, 'get', '/v1/venue-requests/mine').expect(200);
      expect(list.body.items.map((r: { id: string }) => r.id)).toContain(id);

      const approved = await api(staff, 'post', `/v1/admin/venue-requests/${id}/approve`, {
        pitchName: 'Dome 1',
        note: 'checked by phone',
      }).expect(200);
      expect(approved.body.status).toBe('APPROVED');
      const venueId = approved.body.resultingVenueId as string;
      expect(venueId).toBeDefined();
      // approving does not publish: still a draft, hidden from the catalog and from the requester
      const draft = await t.prisma.venue.findUniqueOrThrow({
        where: { id: venueId },
        include: { pitches: true },
      });
      expect(draft).toMatchObject({ kind: 'PAID', status: 'DRAFT', name: 'Big Dome', city });
      expect(draft.pitches).toHaveLength(1);
      expect(draft.pitches[0]).toMatchObject({ name: 'Dome 1', status: 'DRAFT' });
      await t.http().get(`/v1/venues/${venueId}`).expect(404);
      expect((await api(u, 'get', `/v1/venue-requests/${id}`).expect(200)).body.venueId).toBeNull();
      // decisions are final
      await api(staff, 'post', `/v1/admin/venue-requests/${id}/decline`, { message: 'no' }).expect(
        409,
      );
      await api(staff, 'post', `/v1/admin/venue-requests/${id}/approve`, {}).expect(409);

      // publishing is a separate staff action (catalog)
      await api(staff, 'post', `/v1/venues/${venueId}/publish`).expect(404);
      await api(catalog, 'post', `/v1/venues/${venueId}/publish`).expect(200);
      await t.http().get(`/v1/venues/${venueId}`).expect(200);
      expect((await t.prisma.mediaAsset.findUniqueOrThrow({ where: { id: p1 } })).visibility).toBe(
        'PUBLIC',
      );
      const after = await api(u, 'get', `/v1/venue-requests/${id}`).expect(200);
      expect(after.body).toMatchObject({ status: 'APPROVED', venueId });
      const detail = await t.http().get(`/v1/venues/${venueId}`).expect(200);
      expect(detail.body.photoMediaIds).toEqual([p1]);

      // audit + notifications
      for (const action of ['venue.request.needs_info', 'venue.request.approve']) {
        expect(
          await t.prisma.auditEvent.count({
            where: { action, targetId: id, actorId: staff.userId },
          }),
        ).toBe(1);
      }
      expect(
        await t.prisma.notification.count({ where: { recipientId: u.userId, objectId: id } }),
      ).toBeGreaterThanOrEqual(2);
    });

    it('decline carries a reason; approve with publish needs the catalog permission too', async () => {
      const u = await createUser(t);
      const reviewer = await makeStaff(t, 'admin.venueRequests.review');
      const both = await makeStaff(t, 'admin.venueRequests.review', 'admin.catalog.manage');
      const mk = async () =>
        (
          await api(u, 'post', '/v1/venue-requests', {
            name: `Req ${uniq(5)}`,
            city: 'X',
            address: 'a',
            photoMediaIds: [await photo(u)],
          }).expect(201)
        ).body.id as string;
      const a = await mk();
      const b = await mk();
      const dec = await api(reviewer, 'post', `/v1/admin/venue-requests/${a}/decline`, {
        message: 'Already listed',
      }).expect(200);
      expect(dec.body.status).toBe('DECLINED');
      const mine = await api(u, 'get', `/v1/venue-requests/${a}`).expect(200);
      expect(mine.body).toMatchObject({ status: 'DECLINED', message: 'Already listed' });
      await api(reviewer, 'post', `/v1/admin/venue-requests/${a}/decline`, { message: '' }).expect(
        400,
      );
      await api(reviewer, 'post', `/v1/admin/venue-requests/${b}/approve`, {
        publish: true,
      }).expect(403);
      expect((await t.prisma.venueRequest.findUniqueOrThrow({ where: { id: b } })).status).toBe(
        'PENDING',
      );
      const ok = await api(both, 'post', `/v1/admin/venue-requests/${b}/approve`, {
        publish: true,
      }).expect(200);
      const venue = await t.prisma.venue.findUniqueOrThrow({
        where: { id: ok.body.resultingVenueId },
      });
      expect(venue.status).toBe('PUBLISHED');
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'venue.request.decline', targetId: a },
        }),
      ).toBe(1);
    });

    it('two staff approving the same request: exactly one venue is created', async () => {
      const u = await createUser(t);
      const s1 = await makeStaff(t, 'admin.venueRequests.review');
      const s2 = await makeStaff(t, 'admin.venueRequests.review');
      const name = `Twice ${uniq(6)}`;
      const created = await api(u, 'post', '/v1/venue-requests', {
        name,
        city: 'X',
        address: 'a',
        photoMediaIds: [await photo(u)],
      }).expect(201);
      const results = await Promise.all(
        [s1, s2].map((s) =>
          api(s, 'post', `/v1/admin/venue-requests/${created.body.id}/approve`, {}),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await t.prisma.venue.count({ where: { name } })).toBe(1);
    });
  });
});
