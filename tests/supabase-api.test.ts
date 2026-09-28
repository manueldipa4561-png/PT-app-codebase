// src/supabase.ts end to end, with no Docker and no Supabase project: the real supabase-js talks
// HTTP to tests/fake-supabase.ts (Auth and the Data API over PGlite with the real migrations).
// First the shared business scenarios run through the adapter, then every Api method on its own.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { AppError, addDays, localParts, type ErrorCode, type LedgerEntry } from '../src/domain.ts';
import type { Api, Me } from '../src/api.ts';
import { createSupabaseApi } from '../src/supabase.ts';
import { scenarios, type Harness, type Result } from './scenarios.ts';
import { startFakeSupabase, supabaseDatabase, type FakeSupabase } from './fake-supabase.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROME = 'Europe/Rome';
const SIGNED_OUT: Me = { userId: null, email: null, client: null, isOwner: false };

interface Env {
  db: PGlite;
  fake: FakeSupabase;
}
interface Person {
  api: Api;
  id: string;
}

const uuidOf = (key: string) => {
  const h = createHash('md5').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const iso = (ms: number) => new Date(ms).toISOString();
/** The exact format the demo produces and the UI parses: toISOString(). */
const isIso = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v;
const isIsoOrNull = (v: unknown) => v === null || isIso(v);
const today = (tz: string) => localParts(Date.now(), tz).date;
const sum = (xs: LedgerEntry[]) => xs.reduce((s, l) => s + l.delta, 0);

async function fails(p: Promise<unknown>, code: ErrorCode) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, `expected AppError ${code}, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

/** Someone on their own device: their own supabase-js client, signed in with the emailed code. */
async function signUp(env: Env, email: string): Promise<Person> {
  const api = createSupabaseApi(env.fake.url, env.fake.anonKey);
  await api.sendCode(email);
  await api.verifyCode(email, env.fake.codeFor(email));
  const { rows } = await env.db.query<{ id: string }>(`select id from auth.users where email = lower($1)`, [email]);
  return { api, id: rows[0].id };
}

// ── two databases ───────────────────────────────────────────────────────────

// The shared scenarios choose "now", but the public wrappers read now(). In the scenarios'
// database only (never the migration file), the wrappers read a clock setting instead, which the
// fake sets in every request's transaction; unset, it is now(). The other database is untouched.
let scenarioNow: string | null = null;
async function useScenarioClock(db: PGlite) {
  await db.exec(`
    create schema app_test;
    create function app_test.now() returns timestamptz language sql stable
      as $$ select coalesce(nullif(current_setting('app_test.now', true), '')::timestamptz, pg_catalog.now()) $$;`);
  const { rows } = await db.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('free_slots', 'book_session', 'cancel_booking', 'set_attendance')`,
  );
  assert.equal(rows.length, 4);
  for (const { def } of rows) {
    const patched = def.replace(/\bnow\(\)/g, 'app_test.now()');
    assert.equal(patched.split('app_test.now()').length, 2, `expected one now() in ${def}`);
    await db.exec(patched);
  }
}

async function environment(clocked: boolean): Promise<Env> {
  const db = await supabaseDatabase();
  if (!clocked) return { db, fake: await startFakeSupabase(db) };
  await useScenarioClock(db);
  const fake = await startFakeSupabase(db, {
    emailEveryMs: 0, // every scenario person signs in once; the one-email-a-minute limit is tested below
    onTransaction: (tx) => tx.query(`select set_config('app_test.now', $1, true)`, [scenarioNow ?? '']),
  });
  return { db, fake };
}

const scenarioEnv = environment(true);
const liveEnv = environment(false);
scenarioEnv.catch(() => {}); // failures surface in the tests that await them
liveEnv.catch(() => {});
after(async () => {
  for (const env of await Promise.allSettled([scenarioEnv, liveEnv])) {
    if (env.status !== 'fulfilled') continue;
    await env.value.fake.close();
    await env.value.db.close();
  }
});

// ── the shared scenarios, through the adapter ───────────────────────────────

let seq = 0;
function adapterHarness(env: Env): Harness {
  const apis = new Map<string, Api>();
  const owners = new Map<string, string>();
  const as = (userId: string) => {
    const api = apis.get(userId);
    assert.ok(api, `nobody signed in as ${userId}`);
    return api;
  };
  async function user(email: string) {
    const p = await signUp(env, email);
    apis.set(p.id, p.api);
    return p.id;
  }
  /** One adapter call at the scenario's "now": AppErrors become result codes, anything else fails the test. */
  async function run<T>(fn: () => Promise<T>, now?: string): Promise<Result<T>> {
    scenarioNow = now ?? null;
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code };
      throw e;
    } finally {
      scenarioNow = null;
    }
  }
  const count = async (sql: string, params: unknown[]) => Number((await env.db.query<{ n: number }>(sql, params)).rows[0].n);

  return {
    async trainer(o = {}) {
      const owner = await user(`owner-${++seq}@example.com`);
      const { rows } = await env.db.query<{ id: string }>(
        `insert into public.trainers (slug, name, owner_user_id, cancel_window_hours, bonus_referrer, bonus_referred)
         values ($1, 'Test', $2, $3, $4, $5) returning id`,
        [`trainer-${seq}`, owner, o.cancelWindowHours ?? 24, o.bonusReferrer ?? 1, o.bonusReferred ?? 1],
      );
      owners.set(rows[0].id, owner);
      return rows[0].id;
    },
    ownerOf: (trainerId) => owners.get(trainerId)!,
    async sessionType(trainerId, o) {
      const { rows } = await env.db.query<{ id: string }>(
        `insert into public.session_types (trainer_id, name, minutes, capacity, credits) values ($1, 'Session', $2, $3, $4) returning id`,
        [trainerId, o.minutes, o.capacity, o.credits],
      );
      return rows[0].id;
    },
    async availability(trainerId, weekday, start, end, sessionTypeId) {
      await env.db.query(`insert into public.availability (trainer_id, weekday, start_time, end_time, session_type_id) values ($1, $2, $3, $4, $5)`, [
        trainerId,
        weekday,
        start,
        end,
        sessionTypeId ?? null,
      ]);
    },
    async timeOff(trainerId, startsAt, endsAt) {
      await as(owners.get(trainerId)!).addTimeOff(trainerId, startsAt, endsAt);
    },
    user,
    join: (userId, trainerId, referralCode) =>
      run(async () => {
        const c = await as(userId).join(trainerId, { name: 'Test Client', referralCode, acceptTerms: true });
        return { id: c.id, referralCode: c.referralCode };
      }),
    addClient: (ownerId, trainerId, name, email) => run(async () => ({ id: (await as(ownerId).addClient(trainerId, { name, email })).id })),
    book: (userId, typeId, startsAt, now) => run(async () => ({ id: (await as(userId).book(typeId, startsAt)).id }), now),
    bookFor: (ownerId, clientId, typeId, startsAt) => run(async () => ({ id: (await as(ownerId).bookFor(clientId, typeId, startsAt)).id })),
    cancel: (userId, bookingId, now) => run(async () => ({ status: (await as(userId).cancel(bookingId)).status }), now),
    attend: (userId, bookingId, now) => run(async () => ({ status: (await as(userId).setAttendance(bookingId, 'attended')).status }), now),
    packPaid: (actorId, clientId, credits, opKey) =>
      run(async () => ({ rewarded: (await as(actorId).markPackPaid(clientId, { credits, method: 'cash', opId: uuidOf(opKey) })).rewarded })),
    adjust: (actorId, clientId, delta, opKey) => run(async () => (await as(actorId).adjustCredits(clientId, delta, 'test', uuidOf(opKey)), null)),
    reverse: (actorId, referralId) => run(async () => (await as(actorId).reverseReferral(referralId), null)),
    freeSlots: (userId, typeId, from, days, now) => run(async () => (await as(userId).freeSlots(typeId, from, days)).map((s) => s.startsAt), now),
    balance: (clientId) => count(`select coalesce(sum(delta), 0)::int as n from public.credit_ledger where client_id = $1`, [clientId]),
    ledgerCount: (clientId, reason) =>
      count(`select count(*)::int as n from public.credit_ledger where client_id = $1 and ($2::text is null or reason = $2)`, [clientId, reason ?? null]),
    bookingCount: (clientId, status, bookedBy) =>
      count(
        `select count(*)::int as n from public.bookings where client_id = $1 and ($2::text is null or status = $2) and ($3::text is null or booked_by = $3)`,
        [clientId, status ?? null, bookedBy ?? null],
      ),
    packCount: (clientId) => count(`select count(*)::int as n from public.pack_purchases where client_id = $1`, [clientId]),
    async referral(referredClientId) {
      const { rows } = await env.db.query<{ id: string; status: string }>(`select id, status from public.referrals where referred_client_id = $1`, [referredClientId]);
      return rows[0] ?? null;
    },
  };
}

for (const s of scenarios) test(`supabase-js: ${s.name}`, async () => s.run(adapterHarness(await scenarioEnv)));

// ── every Api method, on the real clock ─────────────────────────────────────

interface World {
  env: Env;
  t1: string; // coach-one: Rome, 15-minute grid, 06:00-22:00 daily, owned by whoever signs in as marta@example.com
  t2: string; // coach-two: owned by nico@example.com
  t3: string; // coach-utc: UTC, a 15-minute session all day long, for lists longer than one page
  personal: string;
  circuit: string;
  retired: string;
  sprint: string;
}

const world: Promise<World> = (async () => {
  const env = await liveEnv;
  const id = async (sql: string, params: unknown[] = []) => (await env.db.query<{ id: string }>(sql, params)).rows[0].id;
  const t1 = await id(`insert into public.trainers (slug, name, tagline, domain, owner_email, theme, whatsapp, instagram, slot_step_minutes)
    values ('coach-one', 'Marta Coach', 'Strength, one session at a time', 'app.coach-one.it', 'marta@example.com',
            '{"brand": "#112233", "accent": "#445566", "mode": "dark"}', '+393331234567', 'https://instagram.com/marta.coach', 15) returning id`);
  const t2 = await id(`insert into public.trainers (slug, name, owner_email) values ('coach-two', 'Nico Coach', 'nico@example.com') returning id`);
  const t3 = await id(`insert into public.trainers (slug, name, timezone, slot_step_minutes) values ('coach-utc', 'Utc Coach', 'UTC', 15) returning id`);
  const type = (t: string, name: string, minutes: number, capacity: number, credits: number, sort: number, active: boolean, description: string | null) =>
    id(`insert into public.session_types (trainer_id, name, description, minutes, capacity, credits, sort, active) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [
      t,
      name,
      description,
      minutes,
      capacity,
      credits,
      sort,
      active,
    ]);
  const personal = await type(t1, 'Personal', 60, 1, 1, 1, true, 'One to one');
  const circuit = await type(t1, 'Circuit', 45, 4, 2, 2, true, null);
  const retired = await type(t1, 'Retired', 30, 1, 1, 0, false, null);
  const sprint = await type(t3, 'Sprint', 15, 1, 1, 0, true, null);
  const daily = `insert into public.availability (trainer_id, weekday, start_time, end_time) select $1, d, $2::time, $3::time from generate_series(1, 7) d`;
  await env.db.query(daily, [t1, '06:00', '22:00']);
  await env.db.query(daily, [t3, '00:00', '24:00']);
  await env.db.query(
    `insert into public.products (trainer_id, name, description, price_cents, image_url, payment_url, sort, active) values
       ($1, 'Ten sessions', 'Best value', 9900, 'https://img.example.com/ten.png', 'https://pay.example.com/ten', 2, true),
       ($1, 'Five sessions', null, 5500, null, 'https://pay.example.com/five', 1, true),
       ($1, 'Old pack', null, 100, null, 'https://pay.example.com/old', 0, false)`,
    [t1],
  );
  return { env, t1, t2, t3, personal, circuit, retired, sprint };
})();
world.catch(() => {});

// People and their client records, filled in as the tests below go (they run in order).
const people: Record<string, Person> = {};
const clients: Record<string, string> = {};

test('adapter: getTrainer, sessionTypes and products work signed out; private reads come back empty', async () => {
  const w = await world;
  const anon = createSupabaseApi(w.env.fake.url, w.env.fake.anonKey);
  assert.deepEqual(await anon.getTrainer('coach-one'), {
    id: w.t1,
    slug: 'coach-one',
    name: 'Marta Coach',
    tagline: 'Strength, one session at a time',
    template: 'studio',
    theme: { brand: '#112233', accent: '#445566', mode: 'dark' },
    plan: 'web',
    whatsapp: '+393331234567',
    instagram: 'https://instagram.com/marta.coach',
    timezone: ROME,
    locale: 'it',
    currency: 'EUR',
    slotStepMinutes: 15,
    minNoticeHours: 2,
    bookingHorizonDays: 28,
    cancelWindowHours: 24,
    bonusReferrer: 1,
    bonusReferred: 1,
    termsVersion: 1,
  });
  assert.equal((await anon.getTrainer('  APP.Coach-One.IT ')).id, w.t1);
  await fails(anon.getTrainer('nobody-here'), 'TENANT_NOT_FOUND');

  assert.deepEqual(await anon.sessionTypes(w.t1), [
    { id: w.personal, trainerId: w.t1, name: 'Personal', description: 'One to one', minutes: 60, capacity: 1, credits: 1, active: true, sort: 1 },
    { id: w.circuit, trainerId: w.t1, name: 'Circuit', description: null, minutes: 45, capacity: 4, credits: 2, active: true, sort: 2 },
  ]);
  const products = await anon.products(w.t1);
  assert.deepEqual(
    products.map((p) => [p.trainerId, p.name, p.description, p.priceCents, p.imageUrl, p.paymentUrl, p.active, p.sort]),
    [
      [w.t1, 'Five sessions', null, 5500, null, 'https://pay.example.com/five', true, 1],
      [w.t1, 'Ten sessions', 'Best value', 9900, 'https://img.example.com/ten.png', 'https://pay.example.com/ten', true, 2],
    ],
  );

  assert.deepEqual(await anon.me(w.t1), SIGNED_OUT);
  assert.deepEqual(await anon.myLedger(w.t1), []);
  assert.deepEqual(await anon.myBookings(w.t1), []);
  assert.deepEqual(await anon.myReferrals(w.t1), []);
  await fails(anon.trainerData(w.t1), 'NOT_ALLOWED');
  // without a session the client-only functions are closed at the grant level: same code as the demo
  await fails(anon.freeSlots(w.personal, today(ROME), 7), 'NOT_ALLOWED');
  await fails(anon.book(w.personal, iso(Date.now() + 3 * DAY)), 'NOT_ALLOWED');
  await fails(anon.join(w.t1, { name: 'Nobody', acceptTerms: true }), 'NOT_ALLOWED');
});

test('adapter: sendCode, verifyCode and me', async () => {
  const w = await world;
  const { db, fake } = w.env;
  const api = createSupabaseApi(fake.url, fake.anonKey);
  await fails(api.sendCode('not-an-email'), 'INVALID_INPUT');
  await api.sendCode(' Anna@Example.com ');
  const user = async () =>
    (await db.query<{ id: string; email_confirmed_at: Date | null }>(`select id, email_confirmed_at from auth.users where email = 'anna@example.com'`)).rows[0];
  assert.equal((await user()).email_confirmed_at, null, 'a new login starts unconfirmed');
  await fails(api.sendCode('anna@example.com'), 'RATE_LIMITED'); // one email a minute

  const code = fake.codeFor('anna@example.com');
  await fails(api.verifyCode('anna@example.com', String((Number(code) + 1) % 1_000_000).padStart(6, '0')), 'INVALID_CODE');
  assert.deepEqual(await api.me(w.t1), SIGNED_OUT);
  await api.verifyCode(' ANNA@example.com', ` ${code} `);
  const u = await user();
  assert.ok(u.email_confirmed_at, 'the first code confirms the address');
  assert.deepEqual(await api.me(w.t1), { userId: u.id, email: 'anna@example.com', client: null, isOwner: false });
  await fails(createSupabaseApi(fake.url, fake.anonKey).verifyCode('anna@example.com', code), 'INVALID_CODE'); // a code works once
  people.anna = { api, id: u.id };
});

test("adapter: the trainer's login becomes the owner at its first sign-in", async () => {
  const w = await world;
  const marta = await signUp(w.env, 'Marta@Example.com');
  assert.equal((await marta.api.me(w.t1)).isOwner, true);
  assert.equal((await marta.api.me(w.t2)).isOwner, false);
  const { rows } = await w.env.db.query<{ owner_user_id: string }>(`select owner_user_id from public.trainers where id = $1`, [w.t1]);
  assert.equal(rows[0].owner_user_id, marta.id);
  const nico = await signUp(w.env, 'nico@example.com');
  assert.equal((await nico.api.me(w.t2)).isOwner, true);
  Object.assign(people, { marta, nico });
});

test('adapter: join, with the terms and an invite code; myReferrals', async () => {
  const w = await world;
  const { anna } = people;
  await fails(anna.api.join(w.t1, { name: 'Anna Rossi', acceptTerms: false }), 'INVALID_INPUT');
  const a = await anna.api.join(w.t1, { name: ' Anna Rossi ', phone: '+39 333 1234567', acceptTerms: true });
  assert.deepEqual(
    { ...a, id: '', referralCode: '', termsAcceptedAt: '', createdAt: '' },
    { id: '', trainerId: w.t1, userId: anna.id, name: 'Anna Rossi', email: 'anna@example.com', phone: '+39 333 1234567', referralCode: '', termsAcceptedAt: '', termsVersion: 1, createdAt: '', deletedAt: null },
  );
  assert.match(a.referralCode, /^[0-9A-F]{6}$/);
  assert.ok(isIso(a.termsAcceptedAt) && isIso(a.createdAt), `${a.termsAcceptedAt} ${a.createdAt}`);
  assert.ok(Math.abs(Date.parse(a.createdAt) - Date.now()) < MINUTE);
  assert.deepEqual(await anna.api.join(w.t1, { name: 'Someone Else', acceptTerms: true }), a, 'joining twice returns the first client');
  assert.deepEqual((await anna.api.me(w.t1)).client, a);

  const bruno = await signUp(w.env, 'bruno@example.com');
  const b = await bruno.api.join(w.t1, { name: 'Bruno Verdi', referralCode: ` ${a.referralCode.toLowerCase()} `, acceptTerms: true });
  const invites = await anna.api.myReferrals(w.t1);
  assert.equal(invites.length, 1);
  assert.deepEqual({ ...invites[0], id: '', createdAt: '' }, { id: '', name: 'Bruno', status: 'pending', createdAt: '', rewardedAt: null });
  assert.ok(isIso(invites[0].createdAt));
  assert.deepEqual(await bruno.api.myReferrals(w.t1), []);

  const dario = await signUp(w.env, 'dario@example.com');
  const d = await dario.api.join(w.t1, { name: 'Dario Neri', acceptTerms: true });
  Object.assign(people, { bruno, dario });
  Object.assign(clients, { anna: a.id, bruno: b.id, dario: d.id });
});

test('adapter: trainerData and addClient belong to the owner', async () => {
  const w = await world;
  const { marta, anna, nico } = people;
  const data = await marta.api.trainerData(w.t1);
  assert.deepEqual(data.clients.map((c) => c.name).sort(), ['Anna Rossi', 'Bruno Verdi', 'Dario Neri']);
  assert.deepEqual(data.referrals.map((r) => [r.referrerClientId, r.referredClientId, r.status]), [[clients.anna, clients.bruno, 'pending']]);
  await fails(anna.api.trainerData(w.t1), 'NOT_ALLOWED');
  await fails(nico.api.trainerData(w.t1), 'NOT_ALLOWED');

  const c = await marta.api.addClient(w.t1, { name: ' Carla Bianchi ', email: 'carla@example.com', phone: '+39 347 7654321' });
  assert.deepEqual(
    { ...c, id: '', referralCode: '', createdAt: '' },
    { id: '', trainerId: w.t1, userId: null, name: 'Carla Bianchi', email: 'carla@example.com', phone: '+39 347 7654321', referralCode: '', termsAcceptedAt: null, termsVersion: null, createdAt: '', deletedAt: null },
  );
  assert.ok(isIso(c.createdAt));
  await fails(marta.api.addClient(w.t1, { name: 'Carla Again', email: 'CARLA@example.com' }), 'INVALID_INPUT');
  await fails(anna.api.addClient(w.t1, { name: 'Sneaky' }), 'NOT_ALLOWED');
  await fails(nico.api.addClient(w.t1, { name: 'Sneaky' }), 'NOT_ALLOWED');
});

test('adapter: markPackPaid (referral reward, op_id), adjustCredits, voidPack, reverseReferral', async () => {
  const w = await world;
  const { marta, anna, bruno } = people;
  const op = randomUUID();
  const paid = await marta.api.markPackPaid(clients.bruno, { credits: 10, priceCents: 9900, method: 'transfer', note: ' first pack ', opId: op });
  assert.equal(paid.rewarded, true, 'the first paid pack rewards both people');
  assert.deepEqual(await marta.api.markPackPaid(clients.bruno, { credits: 10, priceCents: 9900, method: 'transfer', opId: op }), { packId: paid.packId, rewarded: false });

  const brunoLedger = await bruno.api.myLedger(w.t1);
  assert.deepEqual(brunoLedger.map((l) => [l.reason, l.delta]).sort(), [['pack', 10], ['referral', 1]]);
  assert.equal(brunoLedger.find((l) => l.reason === 'pack')?.packId, paid.packId);
  for (const l of brunoLedger) assert.ok(l.clientId === clients.bruno && l.trainerId === w.t1 && isIso(l.createdAt));
  const annaReward = await anna.api.myLedger(w.t1);
  assert.deepEqual(annaReward.map((l) => [l.reason, l.delta]), [['referral', 1]]);
  assert.ok(annaReward[0].referralId);
  const [invite] = await anna.api.myReferrals(w.t1);
  assert.equal(invite.status, 'rewarded');
  assert.ok(isIso(invite.rewardedAt));
  const [pack] = (await marta.api.trainerData(w.t1)).packs;
  assert.deepEqual(
    { ...pack, paidAt: '' },
    { id: paid.packId, trainerId: w.t1, clientId: clients.bruno, credits: 10, priceCents: 9900, method: 'transfer', paidAt: '', note: 'first pack', opId: op, voidedAt: null },
  );
  assert.ok(isIso(pack.paidAt));

  const adj = randomUUID();
  await marta.api.adjustCredits(clients.anna, 2, ' welcome gift ', adj);
  await marta.api.adjustCredits(clients.anna, 2, ' welcome gift ', adj);
  await fails(marta.api.adjustCredits(clients.anna, 0, 'zero', randomUUID()), 'INVALID_INPUT');
  await fails(anna.api.adjustCredits(clients.anna, 5, 'self-service', randomUUID()), 'NOT_ALLOWED');
  const manual = (await anna.api.myLedger(w.t1)).filter((l) => l.reason === 'manual');
  assert.deepEqual(manual.map((l) => [l.delta, l.note, l.opId]), [[2, 'welcome gift', adj]]);

  const annaPack = await marta.api.markPackPaid(clients.anna, { credits: 5, method: 'cash', opId: randomUUID() });
  assert.equal(annaPack.rewarded, false);
  await fails(bruno.api.voidPack(annaPack.packId), 'NOT_ALLOWED');
  await marta.api.voidPack(annaPack.packId);
  await fails(marta.api.voidPack(annaPack.packId), 'NOT_FOUND');

  const [referral] = (await marta.api.trainerData(w.t1)).referrals;
  await fails(anna.api.reverseReferral(referral.id), 'NOT_ALLOWED');
  await marta.api.reverseReferral(referral.id);
  await fails(marta.api.reverseReferral(referral.id), 'NOT_FOUND');
  // anna: +1 reward +2 manual +5 pack -5 void -1 reversal; bruno: +10 pack +1 reward -1 reversal
  assert.equal(sum(await anna.api.myLedger(w.t1)), 2);
  assert.equal(sum(await bruno.api.myLedger(w.t1)), 10);
  const voided = (await marta.api.trainerData(w.t1)).packs.find((p) => p.id === annaPack.packId);
  assert.ok(voided && isIso(voided.voidedAt));
});

test('adapter: freeSlots, book and cancel on the real clock', async () => {
  const w = await world;
  const { anna, bruno } = people;
  const start = Date.now();
  const slots = await anna.api.freeSlots(w.personal, today(ROME), 7);
  assert.ok(slots.length > 100, `${slots.length} slots`);
  slots.forEach((s, i) => {
    assert.ok(isIso(s.startsAt) && isIso(s.endsAt), `${s.startsAt} ${s.endsAt}`);
    assert.equal(Date.parse(s.endsAt) - Date.parse(s.startsAt), HOUR);
    assert.equal(s.placesLeft, 1);
    assert.equal(s.location, null);
    assert.ok(Date.parse(s.startsAt) >= start + 2 * HOUR, 'the minimum notice holds');
    if (i) assert.ok(s.startsAt > slots[i - 1].startsAt);
  });
  const far = slots.find((s) => Date.parse(s.startsAt) >= start + 30 * HOUR); // outside the 24 h cancel window
  const near = slots.find((s) => Date.parse(s.startsAt) < start + 20 * HOUR); // inside it
  assert.ok(far && near);

  const b = await anna.api.book(w.personal, far.startsAt);
  assert.deepEqual(
    { ...b, id: '', createdAt: '' },
    { id: '', trainerId: w.t1, clientId: clients.anna, sessionTypeId: w.personal, startsAt: far.startsAt, endsAt: far.endsAt, location: null, status: 'booked', bookedBy: 'client', createdAt: '', cancelledAt: null },
  );
  assert.ok(isIso(b.createdAt));
  assert.equal((await anna.api.book(w.personal, far.startsAt)).id, b.id, 'a retry returns the same booking');
  await fails(bruno.api.book(w.personal, far.startsAt), 'SLOT_TAKEN');
  assert.ok(!(await bruno.api.freeSlots(w.personal, today(ROME), 7)).some((s) => s.startsAt === far.startsAt));

  const cancelled = await anna.api.cancel(b.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(isIso(cancelled.cancelledAt));
  const late = await anna.api.book(w.personal, near.startsAt);
  assert.equal((await anna.api.cancel(late.id)).status, 'late_cancel');
  await fails(anna.api.cancel(late.id), 'NOT_FOUND');
  await fails(bruno.api.cancel(b.id), 'NOT_ALLOWED');
  const moves = (await anna.api.myLedger(w.t1)).filter((l) => l.bookingId).map((l) => [l.reason, l.delta, l.bookingId]);
  assert.deepEqual(moves.sort(), [['booking', -1, b.id], ['booking', -1, late.id], ['refund', 1, b.id]].sort(), 'refunded outside the window only');
  assert.deepEqual((await anna.api.myBookings(w.t1)).map((x) => [x.id, x.status]), [[late.id, 'late_cancel'], [b.id, 'cancelled']]);

  // every refusal, by name (anna has 1 credit left)
  await fails(anna.api.book(w.circuit, far.startsAt), 'NO_CREDITS');
  await fails(anna.api.book(w.personal, iso(start + HOUR)), 'TOO_SOON');
  await fails(anna.api.book(w.personal, iso(start + 40 * DAY)), 'TOO_FAR');
  await fails(anna.api.book(w.personal, iso(Date.parse(far.startsAt) + 7 * MINUTE)), 'OUTSIDE_HOURS');
  await fails(anna.api.book(w.retired, far.startsAt), 'NOT_FOUND');
  await fails(anna.api.book(w.sprint, far.startsAt), 'NOT_ALLOWED');
  await fails(anna.api.freeSlots(w.sprint, today('UTC'), 1), 'NOT_ALLOWED');
  await fails(anna.api.freeSlots(w.personal, today(ROME), 32), 'INVALID_INPUT');
});

test('adapter: bookFor, setAttendance, addTimeOff and removeTimeOff', async () => {
  const w = await world;
  const { marta, anna, dario, nico } = people;
  const past = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR;
  const done = await marta.api.bookFor(clients.dario, w.personal, iso(past));
  assert.deepEqual(
    { ...done, id: '', createdAt: '' },
    { id: '', trainerId: w.t1, clientId: clients.dario, sessionTypeId: w.personal, startsAt: iso(past), endsAt: iso(past + HOUR), location: null, status: 'booked', bookedBy: 'trainer', createdAt: '', cancelledAt: null },
  );
  assert.equal(sum(await dario.api.myLedger(w.t1)), -1, 'the trainer may book past a zero balance');
  await fails(anna.api.setAttendance(done.id, 'attended'), 'NOT_ALLOWED');
  assert.equal((await marta.api.setAttendance(done.id, 'no_show')).status, 'no_show');

  const [later] = await marta.api.freeSlots(w.personal, addDays(today(ROME), 3), 1);
  const upcoming = await marta.api.bookFor(clients.dario, w.personal, later.startsAt);
  await fails(marta.api.setAttendance(upcoming.id, 'attended'), 'NOT_ALLOWED'); // not started yet
  await fails(marta.api.bookFor(clients.anna, w.personal, later.startsAt), 'SLOT_TAKEN');
  await fails(anna.api.bookFor(clients.dario, w.personal, later.startsAt), 'NOT_ALLOWED');

  const off = Date.parse(later.startsAt) + DAY;
  const t = await marta.api.addTimeOff(w.t1, iso(off), iso(off + 4 * HOUR), '  Dentist ');
  assert.deepEqual({ ...t, id: '' }, { id: '', trainerId: w.t1, startsAt: iso(off), endsAt: iso(off + 4 * HOUR), note: 'Dentist' });
  const thatDay = await anna.api.freeSlots(w.personal, localParts(off, ROME).date, 1);
  assert.ok(thatDay.length && thatDay.every((s) => Date.parse(s.endsAt) <= off || Date.parse(s.startsAt) >= off + 4 * HOUR), 'no slot overlaps the time off');
  await fails(marta.api.addTimeOff(w.t1, iso(off + HOUR), iso(off)), 'INVALID_INPUT');
  await fails(anna.api.addTimeOff(w.t1, iso(off), iso(off + HOUR)), 'NOT_ALLOWED');
  await fails(nico.api.removeTimeOff(t.id), 'NOT_FOUND');
  await marta.api.removeTimeOff(t.id);
  await fails(marta.api.removeTimeOff(t.id), 'NOT_FOUND');
  assert.equal((await marta.api.addTimeOff(w.t1, iso(off + 7 * DAY), iso(off + 8 * DAY))).note, null);
});

test('adapter: trainerData maps every list, bookings from the last 120 days', async () => {
  const w = await world;
  const { db } = w.env;
  const { marta, anna } = people;
  await db.query(
    `insert into public.bookings (trainer_id, client_id, session_type_id, starts_at, ends_at, status)
     values ($1, $2, $3, now() - interval '200 days', now() - interval '200 days' + interval '1 hour', 'attended')`,
    [w.t1, clients.anna, w.personal],
  );
  const data = await marta.api.trainerData(w.t1);
  const n = async (sql: string) => Number((await db.query<{ n: number }>(sql, [w.t1])).rows[0].n);
  assert.equal(data.clients.length, await n(`select count(*)::int as n from public.clients where trainer_id = $1`));
  assert.equal(data.bookings.length, await n(`select count(*)::int as n from public.bookings where trainer_id = $1 and starts_at >= now() - interval '120 days'`));
  assert.equal(data.ledger.length, await n(`select count(*)::int as n from public.credit_ledger where trainer_id = $1`));
  assert.deepEqual([data.clients.length, data.bookings.length, data.referrals.length, data.packs.length, data.timeOff.length], [4, 4, 1, 2, 1]);

  const sorted = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
  assert.ok(sorted(data.clients.map((c) => c.createdAt)) && sorted(data.bookings.map((b) => b.startsAt)) && sorted(data.ledger.map((l) => l.createdAt)));
  assert.ok(sorted(data.packs.map((p) => p.paidAt)) && sorted(data.timeOff.map((o) => o.startsAt)));
  for (const c of data.clients) assert.ok(isIso(c.createdAt) && isIsoOrNull(c.termsAcceptedAt) && isIsoOrNull(c.deletedAt));
  for (const b of data.bookings) assert.ok(isIso(b.startsAt) && isIso(b.endsAt) && isIso(b.createdAt) && isIsoOrNull(b.cancelledAt));
  for (const l of data.ledger) assert.ok(isIso(l.createdAt));
  for (const p of data.packs) assert.ok(isIso(p.paidAt) && isIsoOrNull(p.voidedAt));
  for (const o of data.timeOff) assert.ok(isIso(o.startsAt) && isIso(o.endsAt));
  const [r] = data.referrals;
  assert.ok(r.status === 'reversed' && isIso(r.createdAt) && isIso(r.rewardedAt) && isIso(r.reversedAt));
  await fails(anna.api.trainerData(w.t1), 'NOT_ALLOWED');
});

test('adapter: deleteAccount anonymizes the client and removes a login nothing else uses', async () => {
  const w = await world;
  const { db } = w.env;
  const { dario, nico } = people;
  await fails(nico.api.deleteAccount(w.t1), 'NOT_FOUND'); // not a client of this trainer
  await dario.api.deleteAccount(w.t1);
  const { rows } = await db.query<{ name: string; email: string | null; phone: string | null; user_id: string | null; deleted_at: Date | null }>(
    `select name, email, phone, user_id, deleted_at from public.clients where id = $1`,
    [clients.dario],
  );
  assert.deepEqual({ ...rows[0], deleted_at: null }, { name: 'Deleted client', email: null, phone: null, user_id: null, deleted_at: null });
  assert.ok(rows[0].deleted_at);
  const statuses = await db.query<{ status: string }>(`select status from public.bookings where client_id = $1 order by starts_at`, [clients.dario]);
  assert.deepEqual(statuses.rows.map((r) => r.status), ['no_show', 'cancelled'], 'the upcoming session is freed, history stays');
  assert.equal((await db.query(`select 1 from auth.users where id = $1`, [dario.id])).rows.length, 0);
  assert.deepEqual(await dario.api.me(w.t1), SIGNED_OUT);

  const again = await signUp(w.env, 'dario@example.com');
  assert.notEqual(again.id, dario.id);
  assert.equal((await again.api.me(w.t1)).client, null);

  // the account is deleted, then the network drops before the server hears the sign-out
  const hal = await signUp(w.env, 'hal@example.com');
  await hal.api.join(w.t1, { name: 'Hal Moro', acceptTerms: true });
  w.env.fake.dropNext('/auth/v1/logout');
  await hal.api.deleteAccount(w.t1);
  assert.deepEqual(await hal.api.me(w.t1), SIGNED_OUT);
});

test('adapter: signOut, and sessions that ended somewhere else', async () => {
  const w = await world;
  const { anna, bruno } = people;
  await bruno.api.signOut();
  assert.deepEqual(await bruno.api.me(w.t1), SIGNED_OUT);
  assert.deepEqual(await bruno.api.myLedger(w.t1), []);
  await bruno.api.signOut(); // twice is fine

  const ivy = await signUp(w.env, 'ivy@example.com');
  w.env.fake.dropNext('/auth/v1/logout'); // offline: the server never hears it, this device is signed out anyway
  await ivy.api.signOut();
  assert.deepEqual(await ivy.api.me(w.t1), SIGNED_OUT);

  w.env.fake.endSessions(anna.id); // "sign out everywhere" on another device
  assert.deepEqual(await anna.api.me(w.t1), SIGNED_OUT);
  assert.deepEqual(await anna.api.myBookings(w.t1), []);

  const eve = await signUp(w.env, 'eve@example.com');
  await w.env.db.query(`delete from auth.users where id = $1`, [eve.id]); // removed by an admin
  assert.deepEqual(await eve.api.me(w.t1), SIGNED_OUT);
});

test('adapter: lists longer than one page are read whole, and the paging stops', async () => {
  const w = await world;
  const { db } = w.env;
  const fay = await signUp(w.env, 'fay@example.com');
  const c = await fay.api.join(w.t3, { name: 'Fay', acceptTerms: true });
  await db.query(
    `insert into public.credit_ledger (trainer_id, client_id, delta, reason, note)
     select $1, $2, case when g % 2 = 0 then 1 else -1 end, 'manual', 'row ' || g from generate_series(1, 2500) g`,
    [w.t3, c.id],
  );
  const ledger = await fay.api.myLedger(w.t3);
  const expected = await db.query<{ id: string }>(`select id from public.credit_ledger where client_id = $1 order by created_at desc, id`, [c.id]);
  assert.deepEqual(ledger.map((l) => l.id), expected.rows.map((r) => r.id), '2500 rows in three pages, none twice, none lost');

  const slots = await fay.api.freeSlots(w.sprint, today('UTC'), 31);
  assert.ok(slots.length > 2000, `${slots.length} slots`);
  for (let i = 1; i < slots.length; i++) assert.equal(Date.parse(slots[i].startsAt) - Date.parse(slots[i - 1].startsAt), 15 * MINUTE, `gap before slot ${i}`);
});

test('adapter: an unreachable server is NETWORK', async () => {
  const w = await world;
  const port = await new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
  const offline = createSupabaseApi(`http://127.0.0.1:${port}`, w.env.fake.anonKey);
  await fails(offline.getTrainer('coach-one'), 'NETWORK');
  await fails(offline.sendCode('anyone@example.com'), 'NETWORK');
  await fails(offline.verifyCode('anyone@example.com', '123456'), 'NETWORK');
});

test('fake Supabase: answers like PostgREST where the adapter depends on it', async () => {
  const w = await world;
  const { fake } = w.env;
  const sb = createClient(fake.url, fake.anonKey);
  // functions are found by name and argument names: a left-out argument without a default is a 404
  const missing = await sb.rpc('mark_pack_paid', { p_client: randomUUID(), p_credits: 1, p_method: 'cash', p_op_id: randomUUID() });
  assert.deepEqual([missing.status, missing.error?.code], [404, 'PGRST202']);
  // privileges: the anonymous role gets 401
  const join = await sb.rpc('join_trainer', { p_trainer: w.t1, p_name: 'X' });
  assert.deepEqual([join.status, join.error?.code], [401, '42501']);
  const write = await sb.from('credit_ledger').insert({ trainer_id: w.t1, client_id: randomUUID(), delta: 5, reason: 'manual' });
  assert.deepEqual([write.status, write.error?.code], [401, '42501']);
  // row level security decides what a role sees
  assert.deepEqual((await sb.from('clients').select('*')).data, []);
  // a business error raised in SQL is a 400 whose message is the code
  await sb.auth.signInWithOtp({ email: 'gus@example.com' });
  await sb.auth.verifyOtp({ email: 'gus@example.com', token: fake.codeFor('gus@example.com'), type: 'email' });
  const raised = await sb.rpc('join_trainer', { p_trainer: w.t1, p_name: 'Gus', p_accept_terms: false });
  assert.equal(raised.status, 400);
  assert.deepEqual(raised.error && { ...raised.error }, { code: 'P0001', details: null, hint: null, message: 'INVALID_INPUT' });
});
