// Runs the real Supabase migration inside PGlite (Postgres compiled to WASM, no Docker)
// and checks it against the same scenarios as the demo. Before the first real client,
// also run the suite against a disposable hosted Supabase project (see README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { scenarios, type Harness, type Result } from './scenarios.ts';

// Every migration, in order, as `supabase db push` would apply them.
const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

// The minimum of Supabase that the migration expects: an auth schema with users and
// auth.uid(), plus the anon and authenticated roles.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
`;

const uuidOf = (key: string) => {
  const h = createHash('md5').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const toIso = (v: unknown) => new Date(v as string).toISOString();

async function database() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const sql of MIGRATIONS) await db.exec(sql);
  return db;
}

let seq = 0;
function sqlHarness(db: PGlite): Harness {
  const owners = new Map<string, string>();


  const actAs = (userId: string | null) => db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  async function call<T>(userId: string | null, sql: string, params: unknown[], map: (row: Record<string, unknown>) => T): Promise<Result<T>> {
    await actAs(userId);
    try {
      const { rows } = await db.query<Record<string, unknown>>(sql, params);
      return { ok: true, value: map(rows[0]) };
    } catch (e) {
      return { ok: false, code: String((e as Error).message) };
    } finally {
      await actAs(null);
    }
  }
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<Record<string, T>>(sql, params)).rows[0];

  return {
    async trainer(o = {}) {
      const owner = (await one<string>(`insert into auth.users (email) values ($1) returning id`, [`owner${++seq}@example.com`])).id;
      const row = await one<string>(
        `insert into public.trainers (slug, name, owner_user_id, cancel_window_hours, bonus_referrer, bonus_referred)
         values ($1, 'Test', $2, $3, $4, $5) returning id`,
        [`trainer-${seq}`, owner, o.cancelWindowHours ?? 24, o.bonusReferrer ?? 1, o.bonusReferred ?? 1],
      );
      owners.set(row.id, owner);
      return row.id;
    },
    ownerOf: (trainerId) => owners.get(trainerId)!,
    async sessionType(trainerId, o) {
      const row = await one<string>(
        `insert into public.session_types (trainer_id, name, minutes, capacity, credits) values ($1, 'Session', $2, $3, $4) returning id`,
        [trainerId, o.minutes, o.capacity, o.credits],
      );
      return row.id;
    },
    async availability(trainerId, weekday, start, end, sessionTypeId) {
      await db.query(
        `insert into public.availability (trainer_id, weekday, start_time, end_time, session_type_id) values ($1, $2, $3, $4, $5)`,
        [trainerId, weekday, start, end, sessionTypeId ?? null],
      );
    },
    async timeOff(trainerId, startsAt, endsAt) {
      await db.query(`insert into public.time_off (trainer_id, starts_at, ends_at) values ($1, $2, $3)`, [trainerId, startsAt, endsAt]);
    },
    async user(email) {
      return (await one<string>(`insert into auth.users (email) values ($1) returning id`, [email])).id;
    },
    join: (userId, trainerId, referralCode) =>
      call(userId, `select * from public.join_trainer($1, 'Test Client', null, $2, true)`, [trainerId, referralCode ?? null], (r) => ({
        id: r.id as string,
        referralCode: r.referral_code as string,
      })),
    addClient: (ownerId, trainerId, name, email) =>
      call(ownerId, `select * from public.trainer_add_client($1, $2, $3, null)`, [trainerId, name, email], (r) => ({ id: r.id as string })),
    book: (userId, typeId, startsAt, now) =>
      call(userId, `select * from app_private.book($1, $2, $3)`, [typeId, startsAt, now], (r) => ({ id: r.id as string })),
    bookFor: (ownerId, clientId, typeId, startsAt) =>
      call(ownerId, `select * from public.trainer_book($1, $2, $3)`, [clientId, typeId, startsAt], (r) => ({ id: r.id as string })),
    cancel: (userId, bookingId, now) =>
      call(userId, `select * from app_private.cancel($1, $2)`, [bookingId, now], (r) => ({ status: r.status as string })),
    reschedule: (userId, bookingId, startsAt, now) =>
      call(userId, `select * from app_private.reschedule($1, $2, $3)`, [bookingId, startsAt, now], (r) => ({ id: r.id as string })),
    attend: (userId, bookingId, now) =>
      call(userId, `select * from app_private.set_attendance($1, 'attended', $2)`, [bookingId, now], (r) => ({ status: r.status as string })),
    packPaid: (actorId, clientId, credits, opKey) =>
      call(actorId, `select public.mark_pack_paid($1, $2, null, 'cash', null, $3) as r`, [clientId, credits, uuidOf(opKey)], (r) => ({
        rewarded: (r.r as { rewarded: boolean }).rewarded,
      })),
    adjust: (actorId, clientId, delta, opKey) =>
      call(actorId, `select public.adjust_credits($1, $2, 'test', $3)`, [clientId, delta, uuidOf(opKey)], () => null),
    reverse: (actorId, referralId) => call(actorId, `select public.reverse_referral($1)`, [referralId], () => null),
    async freeSlots(userId, typeId, from, days, now) {
      await actAs(userId);
      try {
        const { rows } = await db.query<{ starts_at: string }>(`select starts_at from app_private.free_slots($1, $2::date, $3, $4) order by 1`, [
          typeId,
          from,
          days,
          now,
        ]);
        return { ok: true, value: rows.map((r) => toIso(r.starts_at)) };
      } catch (e) {
        return { ok: false, code: String((e as Error).message) };
      } finally {
        await actAs(null);
      }
    },
    async fullSlots(userId, typeId, from, days, now) {
      await actAs(userId);
      try {
        const { rows } = await db.query<{ starts_at: string }>(`select starts_at from app_private.full_slots($1, $2::date, $3, $4) order by 1`, [typeId, from, days, now]);
        return { ok: true, value: rows.map((r) => toIso(r.starts_at)) };
      } catch (e) {
        return { ok: false, code: String((e as Error).message) };
      } finally {
        await actAs(null);
      }
    },
    joinWaitlist: (userId, typeId, startsAt, now) => call(userId, `select app_private.join_waitlist($1, $2, $3)`, [typeId, startsAt, now], () => null),
    leaveWaitlist: (userId, entryId) => call(userId, `select public.leave_waitlist($1)`, [entryId], () => null),
    async waitlist(userId, trainerId, now) {
      await actAs(userId);
      try {
        const { rows } = await db.query<Record<string, unknown>>(`select * from app_private.waitlist_entries($1, $2)`, [trainerId, now]);
        const value = rows.map((r) => ({
          id: r.id as string,
          clientId: r.client_id as string,
          startsAt: toIso(r.starts_at),
          open: r.open as boolean,
          position: Number(r.position),
        }));
        return { ok: true, value };
      } catch (e) {
        return { ok: false, code: String((e as Error).message) };
      } finally {
        await actAs(null);
      }
    },
    balance: async (clientId) => Number((await one(`select coalesce(sum(delta), 0)::int as n from public.credit_ledger where client_id = $1`, [clientId])).n),
    ledgerCount: async (clientId, reason) =>
      Number((await one(`select count(*)::int as n from public.credit_ledger where client_id = $1 and ($2::text is null or reason = $2)`, [clientId, reason ?? null])).n),
    bookingCount: async (clientId, status, bookedBy) =>
      Number(
        (
          await one(
            `select count(*)::int as n from public.bookings where client_id = $1 and ($2::text is null or status = $2) and ($3::text is null or booked_by = $3)`,
            [clientId, status ?? null, bookedBy ?? null],
          )
        ).n,
      ),
    packCount: async (clientId) => Number((await one(`select count(*)::int as n from public.pack_purchases where client_id = $1`, [clientId])).n),
    referral: async (referredClientId) => {
      const r = await one<string>(`select id, status from public.referrals where referred_client_id = $1`, [referredClientId]);
      return r ? { id: r.id, status: r.status } : null;
    },
  };
}

const shared = database();
for (const s of scenarios) test(`sql: ${s.name}`, async () => s.run(sqlHarness(await shared)));

test('sql: row level security keeps each client to their own rows', async () => {
  const db = await shared;
  const h = sqlHarness(db);
  const t = await h.trainer();
  const owner = h.ownerOf(t);
  const ua = await h.user('rls-a@example.com');
  const ub = await h.user('rls-b@example.com');
  const a = await h.join(ua, t);
  const b = await h.join(ub, t);
  assert.ok(a.ok && b.ok);
  await h.packPaid(owner, a.value.id, 10, 'rls-a');
  await h.packPaid(owner, b.value.id, 10, 'rls-b');

  const other = await h.trainer();
  const outsider = await h.join(await h.user('rls-c@example.com'), other);
  assert.ok(outsider.ok);
  const { rows: [trainerRow] } = await db.query<{ slug: string }>('select slug from public.trainers where id = $1', [t]);

  try {
    await db.exec('set role authenticated');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ua]);
    const clients = await db.query<{ id: string }>('select id from public.clients');
    assert.deepEqual(clients.rows.map((r) => r.id), [a.value.id]);
    const ledger = await db.query<{ client_id: string }>('select client_id from public.credit_ledger');
    assert.ok(ledger.rows.length > 0 && ledger.rows.every((r) => r.client_id === a.value.id));
    await assert.rejects(
      db.query(`insert into public.credit_ledger (trainer_id, client_id, delta, reason) values ($1, $2, 50, 'manual')`, [t, a.value.id]),
    );
    await assert.rejects(db.query(`update public.bookings set status = 'cancelled'`));

    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [owner]);
    const seen = await db.query<{ n: number }>('select count(*)::int as n from public.clients');
    assert.equal(seen.rows[0].n, 2);
    const trainers = await db.query<{ n: number }>('select count(*)::int as n from public.trainers');
    assert.equal(trainers.rows[0].n, 1);

    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await db.exec('set role anon');
    const anonClients = await db.query<{ n: number }>('select count(*)::int as n from public.clients');
    assert.equal(anonClients.rows[0].n, 0);
    const pub = await db.query<{ name: string }>(`select name from public.trainer_public($1)`, [trainerRow.slug]);
    assert.equal(pub.rows.length, 1);
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
});

test('sql: public wrappers never let a caller choose "now"', async () => {
  const db = await shared;
  const { rows } = await db.query<{ args: string }>(
    `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('book_session', 'cancel_booking', 'reschedule_booking', 'free_slots', 'full_slots', 'set_attendance', 'join_waitlist', 'waitlist_entries')`,
  );
  assert.equal(rows.length, 8);
  for (const r of rows) assert.ok(!r.args.includes('p_now'), r.args);

  const can = await db.query<Record<string, boolean>>(`select
    has_function_privilege('anon', 'public.book_session(uuid, timestamptz)', 'execute') as anon_book,
    has_function_privilege('authenticated', 'public.book_session(uuid, timestamptz)', 'execute') as client_book,
    has_function_privilege('authenticated', 'app_private.book(uuid, timestamptz, timestamptz)', 'execute') as client_private,
    has_function_privilege('anon', 'public.reschedule_booking(uuid, timestamptz)', 'execute') as anon_move,
    has_function_privilege('authenticated', 'public.reschedule_booking(uuid, timestamptz)', 'execute') as client_move,
    has_function_privilege('authenticated', 'app_private.reschedule(uuid, timestamptz, timestamptz)', 'execute') as client_move_private,
    has_function_privilege('anon', 'public.join_waitlist(uuid, timestamptz)', 'execute') as anon_wait,
    has_function_privilege('authenticated', 'public.join_waitlist(uuid, timestamptz)', 'execute') as client_wait,
    has_function_privilege('authenticated', 'public.waitlist_entries(uuid)', 'execute') as client_list,
    has_function_privilege('anon', 'public.waitlist_entries(uuid)', 'execute') as anon_list,
    has_function_privilege('authenticated', 'public.leave_waitlist(uuid)', 'execute') as client_leave,
    has_function_privilege('authenticated', 'public.full_slots(uuid, date, int)', 'execute') as client_full,
    has_function_privilege('authenticated', 'app_private.join_waitlist(uuid, timestamptz, timestamptz)', 'execute') as client_wait_private,
    has_function_privilege('authenticated', 'app_private.waitlist_entries(uuid, timestamptz)', 'execute') as client_list_private,
    has_function_privilege('authenticated', 'app_private.full_slots(uuid, date, int, timestamptz)', 'execute') as client_full_private,
    has_table_privilege('authenticated', 'public.waitlist', 'select') as client_read_waitlist,
    has_table_privilege('authenticated', 'public.waitlist', 'insert') as client_write_waitlist,
    has_table_privilege('anon', 'public.waitlist', 'select') as anon_read_waitlist,
    has_function_privilege('anon', 'public.trainer_public(text)', 'execute') as anon_public,
    has_function_privilege('authenticated', 'app_private.onboard_trainer(jsonb)', 'execute') as client_onboard,
    has_table_privilege('authenticated', 'public.session_types', 'delete') as client_delete_type`);
  assert.deepEqual(can.rows[0], {
    anon_book: false,
    client_book: true,
    client_private: false,
    anon_move: false,
    client_move: true,
    client_move_private: false,
    anon_wait: false,
    client_wait: true,
    client_list: true,
    anon_list: false,
    client_leave: true,
    client_full: true,
    client_wait_private: false,
    client_list_private: false,
    client_full_private: false,
    client_read_waitlist: false,
    client_write_waitlist: false,
    anon_read_waitlist: false,
    anon_public: true,
    client_onboard: false,
    client_delete_type: false,
  });
});

const ONBOARD = {
  slug: 'mario-rossi',
  name: 'Mario Rossi PT',
  tagline: 'Personal training a Bologna.',
  template: 'energy',
  plan: 'pro',
  theme: { brand: '#CBF24A', accent: '#FF6A2B', mode: 'dark' },
  whatsapp: '+39 333 123 4567',
  ownerEmail: 'Mario@Example.com',
  sessionTypes: [
    { name: 'Personal 1:1', description: 'Programma su misura.', minutes: 60, credits: 1 },
    { name: 'Small group', minutes: 60, capacity: 4, credits: 1 },
  ],
  availability: [
    { weekday: 1, start: '07:00', end: '10:00', location: 'Palestra Centro' },
    { weekday: 3, start: '19:00', end: '20:00', location: 'Palestra Centro', sessionType: 'Small group' },
  ],
  products: [{ name: 'Kit elastici', priceCents: 2490, paymentUrl: 'https://buy.stripe.com/test' }],
};

test('sql: onboard_trainer sets up a trainer in one call and links the owner on first sign-in', async () => {
  const db = await shared;
  const onboard = async (p: unknown) =>
    (await db.query<{ r: Record<string, unknown> }>(`select app_private.onboard_trainer($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;

  const first = await onboard(ONBOARD);
  assert.deepEqual(
    { owner: first.owner, types: first.session_types, windows: first.availability_windows, products: first.products },
    { owner: "links at the trainer's first sign-in", types: 2, windows: 2, products: 1 },
  );
  const { rows: [t] } = await db.query<{ id: string; whatsapp: string; owner_email: string }>(
    `select id, whatsapp, owner_email from public.trainers where slug = 'mario-rossi'`,
  );
  assert.equal(t.whatsapp, '+393331234567');
  assert.equal(t.owner_email, 'mario@example.com');
  const { rows: [group] } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.availability a join public.session_types s on s.id = a.session_type_id
     where a.trainer_id = $1 and s.name = 'Small group'`,
    [t.id],
  );
  assert.equal(group.n, 1);

  // an unconfirmed sign-up with the owner's email is not the owner; confirming the email is
  const { rows: [u] } = await db.query<{ id: string }>(`insert into auth.users (email, email_confirmed_at) values ('mario@example.com', null) returning id`);
  const ownerOf = async () => (await db.query<{ o: string | null }>(`select owner_user_id as o from public.trainers where id = $1`, [t.id])).rows[0].o;
  assert.equal(await ownerOf(), null);
  await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [u.id]);
  assert.equal(await ownerOf(), u.id);
  const pub = await db.query(`select 1 from public.trainer_public('mario-rossi')`);
  assert.equal(pub.rows.length, 1);

  // re-running with less retires what is missing (bookings may point at it) and keeps the owner
  const again = await onboard({ ...ONBOARD, sessionTypes: ONBOARD.sessionTypes.slice(0, 1), availability: ONBOARD.availability.slice(0, 1), products: [] });
  assert.deepEqual({ owner: again.owner, types: again.session_types, windows: again.availability_windows, products: again.products }, {
    owner: 'linked',
    types: 1,
    windows: 1,
    products: 0,
  });
  const { rows: [kept] } = await db.query<{ n: number }>(`select count(*)::int as n from public.session_types where trainer_id = $1`, [t.id]);
  assert.equal(kept.n, 2);

  await assert.rejects(onboard({ ...ONBOARD, availability: [{ weekday: 2, start: '08:00', end: '09:00', sessionType: 'Yoga' }] }), /session type/);
  await assert.rejects(onboard({ name: 'No slug' }), /slug/);
  await assert.rejects(onboard({ ...ONBOARD, ownerEmail: '<<email con cui il trainer accede>>' }), /placeholder/);
});

test('sql: onboard_trainer links a login that already exists', async () => {
  const db = await shared;
  const { rows: [u] } = await db.query<{ id: string }>(`insert into auth.users (email) values ('giulia.coach@example.com') returning id`);
  const { rows: [r] } = await db.query<{ r: { owner: string } }>(`select app_private.onboard_trainer($1::jsonb) as r`, [
    JSON.stringify({ slug: 'giulia-coach', name: 'Giulia Coach', ownerEmail: 'giulia.coach@example.com' }),
  ]);
  assert.equal(r.r.owner, 'linked');
  const { rows: [t] } = await db.query<{ o: string }>(`select owner_user_id as o from public.trainers where slug = 'giulia-coach'`);
  assert.equal(t.o, u.id);
});

test('sql: trainer settings are checked when they are saved', async () => {
  const db = await shared;
  await assert.rejects(db.query(`insert into public.trainers (slug, name, timezone) values ('bad-zone', 'X', 'Europe/Nowhere')`));
  // a domain needs a dot, so it can never equal another trainer's slug
  await assert.rejects(db.query(`insert into public.trainers (slug, name, domain) values ('no-dot', 'X', 'mario-rossi')`));
  await db.query(`insert into public.trainers (slug, name, domain, timezone) values ('with-dot', 'X', 'app.example.it', 'America/New_York')`);
});

test('sql: packs and the ledger survive a trainer delete until they are removed on purpose', async () => {
  const db = await shared;
  const h = sqlHarness(db);
  const t = await h.trainer();
  const c = await h.join(await h.user('keep-ledger@example.com'), t);
  assert.ok(c.ok);
  assert.ok((await h.packPaid(h.ownerOf(t), c.value.id, 10, 'keep-ledger')).ok);
  await assert.rejects(db.query(`delete from public.trainers where id = $1`, [t]));
  await db.query(`delete from public.credit_ledger where trainer_id = $1`, [t]);
  await db.query(`delete from public.pack_purchases where trainer_id = $1`, [t]);
  await db.query(`delete from public.trainers where id = $1`, [t]);
});

test("sql: deleting a client account never deletes a trainer's own login", async () => {
  const db = await shared;
  const h = sqlHarness(db);
  const mine = await h.trainer();
  const owner = h.ownerOf(mine);
  const other = await h.trainer();
  const joined = await h.join(owner, other); // the trainer is also a client of another trainer
  assert.ok(joined.ok);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [owner]);
  try {
    await db.query(`select public.delete_my_account($1)`, [other]);
  } finally {
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
  const { rows } = await db.query(`select 1 from auth.users where id = $1`, [owner]);
  assert.equal(rows.length, 1);
  const { rows: [t] } = await db.query<{ o: string }>(`select owner_user_id as o from public.trainers where id = $1`, [mine]);
  assert.equal(t.o, owner);
});

test('sql: app opens are counted anonymously and only the owner reads them', async () => {
  const db = await shared;
  const h = sqlHarness(db);
  const t = await h.trainer();
  const owner = h.ownerOf(t);
  const client = await h.user('visits@example.com');
  try {
    await db.exec('set role anon'); // signed out, as on the join screen
    await db.query(`select public.log_visit($1, true)`, [t]);
    await db.query(`select public.log_visit($1, true)`, [t]);
    await db.query(`select public.log_visit($1, false)`, [t]);
    await db.query(`select public.log_visit(gen_random_uuid(), true)`); // unknown trainer: counts nothing, no error
    await assert.rejects(db.query('select * from public.app_visits'));
    await assert.rejects(db.query(`insert into public.app_visits (trainer_id, day, opens) values ($1, current_date, 99)`, [t]));

    await db.exec('set role authenticated');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [client]);
    assert.equal((await db.query('select * from public.app_visits')).rows.length, 0);
    await assert.rejects(db.query(`update public.app_visits set opens = 99`));

    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [owner]);
    const { rows } = await db.query<{ opens: number; installed: number }>('select opens, installed from public.app_visits');
    assert.deepEqual(rows, [{ opens: 3, installed: 2 }]);
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
});
