// Runs the real Supabase migration inside PGlite (Postgres compiled to WASM, no Docker)
// and checks it against the same scenarios as the demo. Before the first real client,
// also run the suite against a disposable hosted Supabase project (see README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { scenarios, type Harness, type Result } from './scenarios.ts';

const MIGRATION = readFileSync(new URL('../supabase/migrations/20260928000000_init.sql', import.meta.url), 'utf8');

// The minimum of Supabase that the migration expects: an auth schema with users and
// auth.uid(), plus the anon and authenticated roles.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
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
  await db.exec(MIGRATION);
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
     where n.nspname = 'public' and p.proname in ('book_session', 'cancel_booking', 'free_slots', 'set_attendance')`,
  );
  assert.equal(rows.length, 4);
  for (const r of rows) assert.ok(!r.args.includes('p_now'), r.args);

  const can = await db.query<Record<string, boolean>>(`select
    has_function_privilege('anon', 'public.book_session(uuid, timestamptz)', 'execute') as anon_book,
    has_function_privilege('authenticated', 'public.book_session(uuid, timestamptz)', 'execute') as client_book,
    has_function_privilege('authenticated', 'app_private.book(uuid, timestamptz, timestamptz)', 'execute') as client_private,
    has_function_privilege('anon', 'public.trainer_public(text)', 'execute') as anon_public`);
  assert.deepEqual(can.rows[0], { anon_book: false, client_book: true, client_private: false, anon_public: true });
});
