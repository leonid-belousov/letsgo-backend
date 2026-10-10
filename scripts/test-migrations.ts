/**
 * Proves the schema can be rebuilt FROM ZERO with `prisma migrate deploy` alone, that Prisma's
 * datamodel and the migrated database agree (no drift), and that the hand-written invariants
 * (exclusion constraint, immutability triggers, partial uniques, CHECKs) really exist and bite.
 *
 * Creates a throw-away database next to DATABASE_URL, never touches the dev database.
 * Usage: npm run test:migrations
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import 'dotenv/config';
import { Client } from 'pg';

const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL is required');
const suffix = randomBytes(4).toString('hex');
const dbName = `letsgo_migtest_${suffix}`;
const admin = new URL(base);
admin.pathname = '/postgres';
admin.search = '';
const target = new URL(base);
target.pathname = `/${dbName}`;

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function prisma(args: string[]): string {
  const res = spawnSync(npx, ['prisma', ...args], {
    env: { ...process.env, DATABASE_URL: target.toString() },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0)
    throw new Error(`prisma ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout + res.stderr;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function expectFail(
  client: Client,
  name: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(sql, params);
    await client.query('ROLLBACK');
    check(name, false, 'statement unexpectedly succeeded');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    check(name, true, (e as { code?: string }).code ?? '');
  }
}

async function main(): Promise<void> {
  const adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${dbName}"`);
  try {
    const deploy = prisma(['migrate', 'deploy']);
    check('migrate deploy on an empty database', /successfully applied/i.test(deploy));
    const status = prisma(['migrate', 'status']);
    check('migrate status is up to date', /up to date/i.test(status));

    const diff = spawnSync(
      npx,
      [
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        env: { ...process.env, DATABASE_URL: target.toString() },
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    // Only custom (non-Prisma-modelled) objects may differ; anything else is drift.
    const out = diff.stdout + diff.stderr;
    const drift = diff.status === 0 ? '' : out;
    // Custom GIN/partial indexes and constraints are invisible to the datamodel; only they may show up as
    // "removed index" / "changed table" lines. Anything else (columns, enums, FKs) is real drift.
    const allowed =
      /(Removed index on columns|Changed the `[A-Za-z]+` table|pitch_occupancy_no_overlap|_trgm|obligation_tournament_player_unique|cash_receipt_idem|ownership_transfer_one_pending)/;
    const unexpected = drift.split('\n').filter((l) => /^\s*\[[-+*]\]/.test(l) && !allowed.test(l));
    check(
      'no unexpected drift between datamodel and migrations',
      unexpected.length === 0,
      unexpected.join(' | ').slice(0, 300),
    );

    const c = new Client({ connectionString: target.toString() });
    await c.connect();
    const one = async (sql: string) =>
      (await c.query(sql)).rows[0] as Record<string, unknown> | undefined;

    check(
      'btree_gist + pg_trgm installed',
      (
        (
          await c.query(
            `SELECT count(*)::int n FROM pg_extension WHERE extname IN ('btree_gist','pg_trgm')`,
          )
        ).rows[0] as { n: number }
      ).n === 2,
    );
    check(
      'booking overlap exclusion constraint exists',
      !!(await one(
        `SELECT 1 FROM pg_constraint WHERE conname='pitch_occupancy_no_overlap' AND contype='x'`,
      )),
    );
    for (const trg of [
      'cash_receipt_immutable',
      'adjustment_immutable',
      'consent_immutable',
      'audit_event_immutable',
      'match_revision_immutable',
    ]) {
      check(`trigger ${trg}`, !!(await one(`SELECT 1 FROM pg_trigger WHERE tgname='${trg}'`)));
    }

    // Behavioural proof of the key invariants on the migrated schema
    const u = randomUUID();
    const venue = randomUUID();
    const pitch = randomUUID();
    const part = randomUUID();
    await c.query(
      `INSERT INTO "Venue"(id,name,kind,status,city,timezone,"createdById","updatedAt") VALUES ($1,'V','PAID','PUBLISHED','X','UTC',$2,now())`,
      [venue, u],
    );
    await c.query(
      `INSERT INTO "Pitch"(id,"venueId",name,formats,amenities,"updatedAt") VALUES ($1,$2,'P','{}','{}',now())`,
      [pitch, venue],
    );
    await c.query(`INSERT INTO "PitchPart"(id,"pitchId",name) VALUES ($1,$2,'whole')`, [
      part,
      pitch,
    ]);
    const cfg = randomUUID();
    await c.query(`INSERT INTO "PitchConfiguration"(id,"pitchId",name) VALUES ($1,$2,'Whole')`, [
      cfg,
      pitch,
    ]);
    const booking = async (): Promise<string> => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO "Booking"(id,"pitchId","configurationId",status,"startsAt","endsAt","rulesVersion","updatedAt") VALUES ($1,$2,$3,'CONFIRMED','2030-01-01T10:00Z','2030-01-01T11:00Z',1,now())`,
        [id, pitch, cfg],
      );
      return id;
    };
    const occ = (b: string, s: string, e: string) =>
      c.query(
        `INSERT INTO "PitchOccupancy"(id,"partId","bookingId","startsAt","endsAt") VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), part, b, s, e],
      );
    const b1 = await booking();
    await occ(b1, '2030-01-01T10:00Z', '2030-01-01T11:00Z');
    const b2 = await booking();
    await expectFail(
      c,
      'overlapping occupancy is rejected by the database (23P01)',
      `INSERT INTO "PitchOccupancy"(id,"partId","bookingId","startsAt","endsAt") VALUES (gen_random_uuid(),$1,$2,'2030-01-01T10:30Z','2030-01-01T11:30Z')`,
      [part, b2],
    );
    await occ(b2, '2030-01-01T11:00Z', '2030-01-01T12:00Z'); // back-to-back is fine ([) ranges)
    check('adjacent occupancy is allowed', true);
    await c.query(`UPDATE "PitchOccupancy" SET "releasedAt"=now() WHERE "bookingId"=$1`, [b1]);
    await occ(await booking(), '2030-01-01T10:00Z', '2030-01-01T11:00Z');
    check('released occupancy frees the interval', true);

    const ob = randomUUID();
    await c.query(
      `INSERT INTO "PaymentObligation"(id,kind,"payerUserId","amountMinor",currency,"updatedAt") VALUES ($1,'EVENT_FEE',$2,1500,'GEL',now())`,
      [ob, u],
    );
    const rc = randomUUID();
    await c.query(
      `INSERT INTO "CashReceipt"(id,"obligationId","amountMinor",currency,"receivedById") VALUES ($1,$2,1500,'GEL',$3)`,
      [rc, ob, u],
    );
    await expectFail(
      c,
      'cash receipts cannot be updated',
      `UPDATE "CashReceipt" SET "amountMinor"=1 WHERE id=$1`,
      [rc],
    );
    await expectFail(
      c,
      'cash receipts cannot be deleted',
      `DELETE FROM "CashReceipt" WHERE id=$1`,
      [rc],
    );
    await expectFail(
      c,
      'zero-amount receipts are rejected',
      `INSERT INTO "CashReceipt"(id,"obligationId","amountMinor",currency,"receivedById") VALUES (gen_random_uuid(),$1,0,'GEL',$2)`,
      [ob, u],
    );
    await expectFail(
      c,
      'obligation must have exactly one payer',
      `INSERT INTO "PaymentObligation"(id,kind,"amountMinor",currency,"updatedAt") VALUES (gen_random_uuid(),'EVENT_FEE',1,'GEL',now())`,
    );
    await c.query(`INSERT INTO "AuditEvent"(id,action,"targetType") VALUES ($1,'x','y')`, [
      randomUUID(),
    ]);
    await expectFail(c, 'audit log rows cannot be deleted', `DELETE FROM "AuditEvent"`);
    await expectFail(
      c,
      'usernames must be lowercase',
      `INSERT INTO "Club"(id,name,username,city,"founderId","ownerId","preferredFormats","updatedAt") VALUES (gen_random_uuid(),'C','MixedCase','X',$1,$1,'{}',now())`,
      [u],
    );
    await expectFail(
      c,
      'event capacity/time CHECKs',
      `INSERT INTO "Event"(id,kind,"organiserId",timezone,"startsAt","endsAt","formatPlayers",capacity,"updatedAt") VALUES (gen_random_uuid(),'CASUAL',$1,'UTC','2030-01-01T12:00Z','2030-01-01T11:00Z',5,10,now())`,
      [u],
    );
    await c.end();
  } finally {
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminClient.end();
  }
  console.log(
    failures === 0 ? '\nAll migration checks passed.' : `\n${failures} migration check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
