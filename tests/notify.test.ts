// The automatic alerts, end to end: the queue in the database (the real migration, in PGlite), and the sender
// (supabase/functions/notify) with a stand-in for Resend. Each test builds its own trainer, so they share one database.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase, supabaseDatabase, type FakeSupabase } from './fake-supabase.ts';
import { handle, sender, type Deps } from '../supabase/functions/notify/handler.ts';
import { render, when, type Alert } from '../supabase/functions/notify/email.ts';
import { sendWithResend, type Mail, type Sent } from '../supabase/functions/notify/resend.ts';

const dbReady = supabaseDatabase();
dbReady.catch(() => {});
let fakeReady: Promise<FakeSupabase> | null = null;
const fake = () => (fakeReady ??= dbReady.then((db) => startFakeSupabase(db)));
after(async () => {
  if (fakeReady) await (await fakeReady).close();
  await (await dbReady).close();
});

let seq = 0;
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, T>>(sql, params)).rows[0];

/** A trainer in Rome with one 1:1 session type, open 06:00-22:00 every day, and the alerts set up. */
async function world(db: PGlite, over: { locale?: string; capacity?: number } = {}) {
  const n = ++seq;
  const t = (
    await one<string>(
      db,
      `insert into public.trainers (slug, name, owner_email, domain, locale, slot_step_minutes)
       values ($1, 'Marta Coach', 'marta@example.com', $2, $3, 60) returning id`,
      [`alerts-${n}`, `app.marta${n}.it`, over.locale ?? 'it'],
    )
  ).id;
  const type = (
    await one<string>(db, `insert into public.session_types (trainer_id, name, minutes, capacity, credits) values ($1, 'Personal', 60, $2, 1) returning id`, [t, over.capacity ?? 1])
  ).id;
  await db.query(`insert into public.availability (trainer_id, weekday, start_time, end_time) select $1, d, '06:00', '22:00' from generate_series(1, 7) d`, [t]);
  await db.query(`delete from app_private.outbox`); // the sender serves every trainer: start each test with an empty queue
  await db.query(`delete from app_private.settings`);
  await db.query(`select app_private.notify_setup('https://project.supabase.co/functions/v1/notify', 'avvisi@marta.it', null)`);
  const secret = (await one<string>(db, `select value from app_private.settings where key = 'notify_secret'`)).value;
  return { t, type, secret, domain: `app.marta${n}.it` };
}
type World = Awaited<ReturnType<typeof world>>;

async function client(db: PGlite, w: World, name: string, email: string) {
  const u = (await one<string>(db, `insert into auth.users (email) values ($1) returning id`, [email])).id;
  const c = (
    await one<string>(
      db,
      `insert into public.clients (trainer_id, user_id, name, email, referral_code) values ($1, $2, $3, $4, app_private.new_referral_code($1)) returning id`,
      [w.t, u, name, email],
    )
  ).id;
  return { u, c };
}
/** 10:00 (or `hour`) in Rome, `days` days from now, as an ISO instant. */
async function at(db: PGlite, days: number, hour = 10) {
  const r = await one<Date>(db, `select ((date_trunc('day', now() at time zone 'Europe/Rome') + make_interval(days => $1, hours => $2)) at time zone 'Europe/Rome') as t`, [days, hour]);
  return new Date(r.t).toISOString();
}
const book = async (db: PGlite, w: World, clientId: string, startsAt: string, minutes = 60) =>
  (
    await one<string>(
      db,
      `insert into public.bookings (trainer_id, client_id, session_type_id, starts_at, ends_at, booked_by)
       values ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(mins => $5), 'client') returning id`,
      [w.t, clientId, w.type, startsAt, minutes],
    )
  ).id;
const wait = (db: PGlite, w: World, clientId: string, startsAt: string) =>
  db.query(`insert into public.waitlist (trainer_id, client_id, session_type_id, starts_at) values ($1, $2, $3, $4)`, [w.t, clientId, w.type, startsAt]);
const cancel = (db: PGlite, bookingId: string) => db.query(`update public.bookings set status = 'cancelled', cancelled_at = now() where id = $1`, [bookingId]);
const queue = async (db: PGlite, w: World) =>
  (await db.query<{ client_id: string; status: string; attempts: number; last_error: string | null }>(
    `select client_id, status, attempts, last_error from app_private.outbox where trainer_id = $1 order by client_id`,
    [w.t],
  )).rows;
const ids = (...xs: string[]) => xs.sort();

test('a cancellation queues one alert for each client waiting for that session, and for nobody else', async () => {
  const db = await dbReady;
  const w = await world(db);
  const slot = await at(db, 3);
  const holder = await client(db, w, 'Holder One', 'holder@example.com');
  const bea = await client(db, w, 'Bea Waiting', 'bea@example.com');
  const carlo = await client(db, w, 'Carlo Waiting', 'carlo@example.com');
  const dora = await client(db, w, 'Dora Elsewhere', 'dora@example.com'); // waits for another time
  const gone = await client(db, w, 'Gone Client', 'gone@example.com'); // erased since
  const held = await book(db, w, holder.c, slot);
  for (const c of [bea, carlo, gone]) await wait(db, w, c.c, slot);
  await wait(db, w, dora.c, await at(db, 4));
  await db.query(`update public.clients set deleted_at = now() where id = $1`, [gone.c]);

  await cancel(db, held);
  assert.deepEqual((await queue(db, w)).map((r) => [r.client_id, r.status]), ids(bea.c, carlo.c).map((c) => [c, 'pending']));
  const { rows } = await db.query<{ ok: boolean; keys: number }>(
    `select bool_and(expires_at > now() and expires_at <= now() + interval '61 minutes') as ok, count(distinct dedupe_key)::int as keys from app_private.outbox where trainer_id = $1`,
    [w.t],
  );
  assert.deepEqual(rows[0], { ok: true, keys: 2 }); // useful for an hour at most, one key each
});

test('no alert when the place is not free, too close, retired, or told an hour ago already', async () => {
  const db = await dbReady;
  const w = await world(db);
  const [holder, other, waiter] = [await client(db, w, 'H', 'h@example.com'), await client(db, w, 'O', 'o@example.com'), await client(db, w, 'W', 'w@example.com')];

  // the trainer is busy with another session overlapping it: cancelling frees nothing
  const busy = await at(db, 3, 10);
  await wait(db, w, waiter.c, busy);
  const first = await book(db, w, holder.c, busy);
  await book(db, w, other.c, new Date(Date.parse(busy) + 30 * 60_000).toISOString());
  await cancel(db, first);
  assert.equal((await queue(db, w)).length, 0);

  // inside the minimum notice a client cannot book it any more
  await db.query(`update public.trainers set min_notice_hours = 72 where id = $1`, [w.t]);
  const near = await at(db, 1, 12);
  await wait(db, w, waiter.c, near);
  await cancel(db, await book(db, w, holder.c, near));
  assert.equal((await queue(db, w)).length, 0);
  await db.query(`update public.trainers set min_notice_hours = 2 where id = $1`, [w.t]);

  // a retired session type cannot be booked
  const retired = await at(db, 5, 9);
  await wait(db, w, waiter.c, retired);
  const held = await book(db, w, holder.c, retired);
  await db.query(`update public.session_types set active = false where id = $1`, [w.type]);
  await cancel(db, held);
  assert.equal((await queue(db, w)).length, 0);
  await db.query(`update public.session_types set active = true where id = $1`, [w.type]);

  // told once an hour: booking and cancelling the same time again does not tell them again
  const loop = await at(db, 6, 15);
  await wait(db, w, waiter.c, loop);
  await cancel(db, await book(db, w, holder.c, loop));
  assert.equal((await queue(db, w)).length, 1);
  await cancel(db, await book(db, w, other.c, loop));
  assert.equal((await queue(db, w)).length, 1);
  await db.query(`update app_private.outbox set created_at = now() - interval '2 hours' where trainer_id = $1`, [w.t]);
  await cancel(db, await book(db, w, other.c, loop));
  assert.equal((await queue(db, w)).length, 2); // a new opening an hour later is news again
});

test('a group session with one place left alerts, and the real cancel and a failed move behave', async () => {
  const db = await dbReady;
  const w = await world(db, { capacity: 2 });
  const [a1, a2, waiter] = [await client(db, w, 'A1', 'a1@example.com'), await client(db, w, 'A2', 'a2@example.com'), await client(db, w, 'W', 'w@example.com')];
  const slot = await at(db, 3, 17);
  const b1 = await book(db, w, a1.c, slot);
  await book(db, w, a2.c, slot);
  await wait(db, w, waiter.c, slot);
  // the client cancels through the real function, as their phone does
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [a1.u]);
  await db.query(`select * from app_private.cancel($1, now())`, [b1]);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  assert.deepEqual((await queue(db, w)).map((r) => [r.client_id, r.status]), [[waiter.c, 'pending']]);

  // a move that fails is rolled back with everything it did, the alert included
  const w2 = await world(db);
  const [mover, taker, hopeful] = [await client(db, w2, 'M', 'm@example.com'), await client(db, w2, 'T', 'tk@example.com'), await client(db, w2, 'Hp', 'hp@example.com')];
  const mine = await at(db, 4, 9);
  const theirs = await at(db, 4, 12);
  await db.query(`insert into public.credit_ledger (trainer_id, client_id, delta, reason) values ($1, $2, 5, 'manual')`, [w2.t, mover.c]);
  const move = await book(db, w2, mover.c, mine);
  await book(db, w2, taker.c, theirs);
  await wait(db, w2, hopeful.c, mine);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [mover.u]);
  await assert.rejects(db.query(`select * from app_private.reschedule($1, $2::timestamptz, now())`, [move, theirs]), /SLOT_TAKEN/);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  assert.equal((await queue(db, w2)).length, 0);
  const still = await one<string>(db, `select status from public.bookings where id = $1`, [move]);
  assert.equal(still.status, 'booked');
});

// ── the sender asks for work ────────────────────────────────────────────────

type Claimed = Alert & { id: string };
const claim = (db: PGlite, secret: string | null, limit = 20) => db.query<Claimed>(`select * from public.claim_notifications($1, $2)`, [secret, limit]);
/** One waiting client, one cancellation: one alert queued. */
async function alert(db: PGlite, w: World, days: number, who: string, email = `${who}@example.com`) {
  const slot = await at(db, days);
  const holder = await client(db, w, `Holder ${who}`, `holder-${who}@example.com`);
  const waiter = await client(db, w, `${who} Waiting`, email);
  const held = await book(db, w, holder.c, slot);
  await wait(db, w, waiter.c, slot);
  await cancel(db, held);
  return { slot, waiter: waiter.c, holder: holder.c };
}

test('claim_notifications needs the secret and the setup, hands out what the email needs, and not twice', async () => {
  const db = await dbReady;
  const w = await world(db);
  const a = await alert(db, w, 3, 'bea');

  await assert.rejects(claim(db, 'wrong'), /NOT_ALLOWED/);
  await assert.rejects(claim(db, null), /NOT_ALLOWED/);
  await db.query(`delete from app_private.settings where key = 'notify_from'`);
  await assert.rejects(claim(db, w.secret), /NOT_CONFIGURED/);
  await db.query(`insert into app_private.settings (key, value) values ('notify_from', 'avvisi@marta.it')`);

  const { rows } = await claim(db, w.secret);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], id: '', starts_at: '' },
    {
      id: '', kind: 'waitlist_open', to_email: 'bea@example.com', to_name: 'bea Waiting', trainer_name: 'Marta Coach', reply_to: 'marta@example.com',
      locale: 'it', timezone: 'Europe/Rome', session_name: 'Personal', starts_at: '', location: null, app_url: `https://${w.domain}`, from_address: 'avvisi@marta.it',
    },
  );
  assert.equal(new Date(rows[0].starts_at).toISOString(), a.slot);
  assert.equal((await claim(db, w.secret)).rows.length, 0, 'being tried: not handed out twice');
  await db.query(`update app_private.outbox set claimed_at = now() - interval '4 minutes' where trainer_id = $1`, [w.t]);
  assert.equal((await claim(db, w.secret)).rows.length, 1, 'nobody finished it: offered again');
  assert.deepEqual((await queue(db, w)).map((q) => [q.status, q.attempts]), [['pending', 2]]);

  // without an address of their own the trainer is reached through the base domain, when there is one
  await db.query(`update public.trainers set domain = null where id = $1`, [w.t]);
  await db.query(`select app_private.notify_setup('https://project.supabase.co/functions/v1/notify', 'avvisi@marta.it', 'App.Example.IT')`);
  await db.query(`update app_private.outbox set claimed_at = now() - interval '4 minutes' where trainer_id = $1`, [w.t]);
  const slug = (await one<string>(db, `select slug from public.trainers where id = $1`, [w.t])).slug;
  assert.equal((await claim(db, w.secret)).rows[0].app_url, `https://${slug}.app.example.it`);
});

test('claim_notifications drops alerts that no longer matter, and says why', async () => {
  const db = await dbReady;
  const w = await world(db);
  const taken = await alert(db, w, 3, 'taken');
  const left = await alert(db, w, 4, 'left');
  const old = await alert(db, w, 5, 'old');
  const other = await client(db, w, 'Quick One', 'quick@example.com');
  await book(db, w, other.c, taken.slot); // someone else booked the place first
  await db.query(`delete from public.waitlist where client_id = $1`, [left.waiter]); // they left the list
  await db.query(`update app_private.outbox set expires_at = now() - interval '1 minute' where client_id = $1`, [old.waiter]);

  assert.equal((await claim(db, w.secret)).rows.length, 0);
  const why = Object.fromEntries((await queue(db, w)).map((q) => [q.client_id, [q.status, q.last_error]]));
  assert.deepEqual(why, {
    [taken.waiter]: ['skipped', 'no longer open'],
    [left.waiter]: ['skipped', 'no longer open'],
    [old.waiter]: ['skipped', 'expired'],
  });
});

test('finish_notification: sent, to try again, or given up', async () => {
  const db = await dbReady;
  const w = await world(db);
  const slot = await at(db, 3);
  const holder = await client(db, w, 'Holder', 'holder@example.com');
  const waiting = await Promise.all(['a', 'b', 'c', 'd'].map((n) => client(db, w, `W ${n}`, `${n}@example.com`)));
  const held = await book(db, w, holder.c, slot);
  for (const c of waiting) await wait(db, w, c.c, slot);
  await cancel(db, held);
  const byMail = Object.fromEntries((await claim(db, w.secret)).rows.map((r) => [r.to_email, r.id]));
  const finish = (mail: string, error: string | null, retry = true, secret: string = w.secret) =>
    db.query(`select public.finish_notification($1, $2, $3, $4)`, [secret, byMail[mail], error, retry]);
  const state = async (mail: string) => await one<string | number>(db, `select status, attempts, last_error, sent_at is not null as sent from app_private.outbox where id = $1`, [byMail[mail]]);

  await assert.rejects(finish('a@example.com', null, true, 'wrong'), /NOT_ALLOWED/);
  await finish('a@example.com', null);
  assert.deepEqual(await state('a@example.com'), { status: 'sent', attempts: 1, last_error: null, sent: true });
  await finish('b@example.com', 'resend 429: slow down', true);
  assert.deepEqual(await state('b@example.com'), { status: 'pending', attempts: 1, last_error: 'resend 429: slow down', sent: false });
  await finish('c@example.com', 'resend 422: bad address', false);
  assert.deepEqual(await state('c@example.com'), { status: 'failed', attempts: 1, last_error: 'resend 422: bad address', sent: false });
  await db.query(`update app_private.outbox set attempts = 5 where id = $1`, [byMail['d@example.com']]);
  await finish('d@example.com', 'resend 500: down', true);
  assert.equal((await state('d@example.com')).status, 'failed', 'the fifth try is the last');
  await finish('a@example.com', 'late news'); // one that is already sent stays sent
  assert.equal((await state('a@example.com')).status, 'sent');
});

// ── the sender ──────────────────────────────────────────────────────────────

/** The sender as the Edge Function builds it: supabase-js with the service key, and a stand-in for Resend that keeps the mails. */
async function sendDeps(w: World, mails: Mail[], over: Partial<Deps> = {}): Promise<Deps> {
  const f = await fake();
  const sb = createClient(f.url, f.serviceKey, { auth: { persistSession: false } });
  return { secret: w.secret, configured: true, rpc: (name, args) => sb.rpc(name, args), send: async (m) => (mails.push(m), { ok: true }), ...over };
}
const backoff = (db: PGlite, w: World) => db.query(`update app_private.outbox set claimed_at = now() - interval '4 minutes' where trainer_id = $1`, [w.t]);

test('the sender does nothing without the secret or the key, and spends no try', async () => {
  const db = await dbReady;
  const w = await world(db);
  await alert(db, w, 3, 'bea');
  const mails: Mail[] = [];
  assert.deepEqual(await handle(await sendDeps(w, mails, { secret: null })), { status: 401, body: { error: 'unauthorized' } });
  assert.equal((await handle(await sendDeps(w, mails, { secret: 'wrong' }))).status, 401);
  assert.equal((await handle(await sendDeps(w, mails, { secret: 'wrong', configured: false }))).status, 401); // who asks comes first
  const noKey = await handle(await sendDeps(w, mails, { configured: false }));
  assert.equal(noKey.status, 503);
  assert.match(String(noKey.body.error), /RESEND_API_KEY/);
  await db.query(`update app_private.settings set key = 'notify_from_off' where key = 'notify_from'`);
  assert.equal((await handle(await sendDeps(w, mails))).status, 503);
  assert.match(String((await handle(await sendDeps(w, mails, { configured: false }))).body.error), /notify_setup/);
  assert.equal(mails.length, 0);
  assert.deepEqual((await queue(db, w)).map((q) => [q.status, q.attempts]), [['pending', 0]]);
});

test('the sender writes one email for each waiting client and reports each one', async () => {
  const db = await dbReady;
  const w = await world(db);
  const slot = await at(db, 3);
  const holder = await client(db, w, 'Holder', 'holder@example.com');
  const bea = await client(db, w, 'Bea Rossi', 'bea@example.com');
  const carlo = await client(db, w, 'Carlo Neri', 'carlo@example.com');
  const held = await book(db, w, holder.c, slot);
  await wait(db, w, bea.c, slot);
  await wait(db, w, carlo.c, slot);
  await cancel(db, held);

  const mails: Mail[] = [];
  assert.deepEqual(await handle(await sendDeps(w, mails)), { status: 200, body: { claimed: 2, sent: 2, retry: 0, failed: 0 } });
  mails.sort((x, y) => x.to.localeCompare(y.to));
  assert.deepEqual(mails.map((m) => m.to), ['bea@example.com', 'carlo@example.com']);
  const m = mails[0];
  assert.equal(m.from, '"Marta Coach" <avvisi@marta.it>');
  assert.equal(m.replyTo, 'marta@example.com');
  assert.match(m.subject, /^Si è liberato un posto: \S+ \d+ \S+ alle 10:00$/);
  assert.match(m.text, /^Ciao Bea,\n\nsi è liberato un posto per Personal, /);
  assert.ok(m.text.includes(`https://${w.domain}`) && m.html.includes(`href="https://${w.domain}"`));
  const key = await one<string>(db, `select o.id from app_private.outbox o join public.clients c on c.id = o.client_id where c.email = 'bea@example.com' and o.trainer_id = $1`, [w.t]);
  assert.equal(m.idempotencyKey, key.id);
  assert.deepEqual((await queue(db, w)).map((q) => q.status), ['sent', 'sent']);
  assert.equal((await handle(await sendDeps(w, mails))).body.claimed, 0); // nothing left to do
});

test('a busy Resend is tried again, a rejected address is given up on', async () => {
  const db = await dbReady;
  const w = await world(db);
  await alert(db, w, 3, 'bea');
  const mails: Mail[] = [];
  const busy = (e: Sent): Partial<Deps> => ({ send: async () => e });
  assert.deepEqual((await handle(await sendDeps(w, mails, busy({ ok: false, retry: true, error: 'resend 429: slow down' })))).body, { claimed: 1, sent: 0, retry: 1, failed: 0 });
  assert.deepEqual((await queue(db, w)).map((q) => [q.status, q.attempts, q.last_error]), [['pending', 1, 'resend 429: slow down']]);
  await backoff(db, w);
  const boom: Partial<Deps> = { send: async () => { throw new Error('boom'); } };
  assert.equal((await handle(await sendDeps(w, mails, boom))).body.retry, 1); // whatever goes wrong, it is tried again
  assert.match((await queue(db, w))[0].last_error ?? '', /^unexpected: boom/);
  await backoff(db, w);
  assert.equal((await handle(await sendDeps(w, mails))).body.sent, 1);
  assert.deepEqual((await queue(db, w)).map((q) => [q.status, q.attempts]), [['sent', 3]]);

  const other = await alert(db, w, 4, 'dan');
  assert.deepEqual((await handle(await sendDeps(w, mails, busy({ ok: false, retry: false, error: 'resend 422: invalid address' })))).body, { claimed: 1, sent: 0, retry: 0, failed: 1 });
  assert.equal((await queue(db, w)).find((q) => q.client_id === other.waiter)?.status, 'failed');
});

test('an English trainer writes in English', async () => {
  const db = await dbReady;
  const w = await world(db, { locale: 'en' });
  await alert(db, w, 3, 'bea');
  const mails: Mail[] = [];
  await handle(await sendDeps(w, mails));
  assert.match(mails[0].subject, /^A place opened up: \S+,? \d+ \S+ at 10:00$/);
  assert.match(mails[0].text, /^Hi bea,\n\na place has opened up for Personal, /);
});

// ── the words and the Resend request ────────────────────────────────────────

const ALERT: Alert = {
  id: 'a1', kind: 'waitlist_open', to_email: 'bea@example.com', to_name: 'Bea Rossi', trainer_name: 'Marta Coach', reply_to: 'marta@example.com',
  locale: 'it', timezone: 'Europe/Rome', session_name: 'Personal 1:1', starts_at: '2026-10-08T16:30:00.000Z', location: 'Palestra Navigli',
  app_url: 'https://app.marta.it', from_address: 'avvisi@marta.it',
};

test('the email is in the trainer language and time zone, and safe to show', () => {
  assert.equal(when('2026-10-08T16:30:00.000Z', 'Europe/Rome', 'it'), 'giovedì 8 ottobre alle 18:30');
  assert.equal(when('2026-10-08T16:30:00.000Z', 'America/New_York', 'it'), 'giovedì 8 ottobre alle 12:30');
  const r = render(ALERT);
  assert.equal(r.subject, 'Si è liberato un posto: giovedì 8 ottobre alle 18:30');
  assert.ok(r.text.startsWith('Ciao Bea,\n\nsi è liberato un posto per Personal 1:1, giovedì 8 ottobre alle 18:30 (Palestra Navigli).\nLo ha chi prenota per primo.'));
  assert.ok(r.text.includes('Prenota ora: https://app.marta.it') && r.html.includes('href="https://app.marta.it"'));
  assert.ok(r.text.includes('sei in lista d’attesa da Marta Coach') && r.text.endsWith('— Marta Coach'));

  // whatever a name holds stays text, and no address means no link
  const hostile = render({ ...ALERT, to_name: '<script>alert(1)</script> X', trainer_name: 'Marta "Coach" <b>', app_url: 'http://not-secure.example' });
  assert.ok(!hostile.html.includes('<script>') && !hostile.html.includes('<b>') && !hostile.html.includes('href='));
  assert.ok(hostile.text.includes('Apri l’app di Marta "Coach" <b> e prenota.'));
  const en = render({ ...ALERT, locale: 'en', location: null, app_url: null });
  assert.match(en.subject, /^A place opened up: Thursday,? 8 October at 18:30$/);
  assert.ok(en.text.includes('a place has opened up for Personal 1:1,') && en.text.includes('Open Marta Coach’s app and book.'));
});

test('the sender line carries the trainer name, and nothing that could break a header', () => {
  assert.equal(sender('Marta Coach', 'avvisi@marta.it'), '"Marta Coach" <avvisi@marta.it>');
  assert.equal(sender('Mar"ta\r\nBcc: x@evil.it \ Coach', 'avvisi@marta.it'), '"Marta Bcc: x@evil.it Coach" <avvisi@marta.it>');
});

test('the Resend request, and which answers are worth another try', async () => {
  const mail: Mail = { from: '"Marta" <avvisi@marta.it>', to: 'bea@example.com', subject: 'S', html: '<p>h</p>', text: 't', replyTo: 'marta@example.com', idempotencyKey: 'id-1' };
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (status: number): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => (calls.push({ url: String(url), init: init ?? {} }), new Response('{"message":"x"}', { status }))) as typeof fetch;

  assert.deepEqual(await sendWithResend(answer(200), 're_key', mail), { ok: true });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { Authorization: 'Bearer re_key', 'Content-Type': 'application/json', 'Idempotency-Key': 'id-1' });
  assert.deepEqual(JSON.parse(String(init.body)), { from: mail.from, to: ['bea@example.com'], subject: 'S', html: '<p>h</p>', text: 't', reply_to: 'marta@example.com' });
  await sendWithResend(answer(200), 're_key', { ...mail, replyTo: null });
  assert.ok(!('reply_to' in JSON.parse(String(calls[1].init.body))));

  for (const [status, retry] of [[429, true], [500, true], [503, true], [401, true], [403, true], [400, false], [404, false], [422, false]] as const) {
    const r = await sendWithResend(answer(status), 're_key', mail);
    assert.deepEqual([r.ok, r.ok ? null : r.retry], [false, retry], `status ${status}`);
  }
  const down = await sendWithResend((async () => { throw new TypeError('fetch failed'); }) as typeof fetch, 're_key', mail);
  assert.deepEqual(down, { ok: false, retry: true, error: 'network: fetch failed' });
});

// ── who may call what, and the minute job ───────────────────────────────────

test('the queue and the sender functions are closed to everyone but the sender', async () => {
  const db = await dbReady;
  const { rows } = await db.query<Record<string, boolean>>(`select
    has_function_privilege('anon', 'public.claim_notifications(text, int)', 'execute') as anon_claim,
    has_function_privilege('authenticated', 'public.claim_notifications(text, int)', 'execute') as client_claim,
    has_function_privilege('service_role', 'public.claim_notifications(text, int)', 'execute') as sender_claim,
    has_function_privilege('anon', 'public.finish_notification(text, uuid, text, boolean)', 'execute') as anon_finish,
    has_function_privilege('authenticated', 'public.finish_notification(text, uuid, text, boolean)', 'execute') as client_finish,
    has_function_privilege('service_role', 'public.finish_notification(text, uuid, text, boolean)', 'execute') as sender_finish,
    has_function_privilege('service_role', 'app_private.notify_setup(text, text, text)', 'execute') as sender_setup,
    has_function_privilege('authenticated', 'app_private.notify_wake()', 'execute') as client_wake,
    has_function_privilege('authenticated', 'app_private.waitlist_alert_after_cancel()', 'execute') as client_trigger,
    has_function_privilege('authenticated', 'app_private.slot_is_open(uuid, timestamptz, timestamptz)', 'execute') as client_open,
    has_table_privilege('authenticated', 'app_private.outbox', 'select') as client_queue,
    has_table_privilege('anon', 'app_private.settings', 'select') as anon_settings`);
  assert.deepEqual(rows[0], {
    anon_claim: false, client_claim: false, sender_claim: true, anon_finish: false, client_finish: false, sender_finish: true,
    sender_setup: false, client_wake: false, client_trigger: false, client_open: false, client_queue: false, anon_settings: false,
  });
});

test('notify_wake asks the function to run only when something waits and the project is set up', async () => {
  const db = await dbReady;
  // pg_net is not in this database: a stand-in that keeps the calls, with the same argument names
  await db.exec(`
    create schema if not exists net;
    create table if not exists net.calls (url text, headers jsonb, body jsonb);
    create or replace function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
      returns bigint language sql as $$ insert into net.calls values (url, headers, body); select 1::bigint $$;
    truncate net.calls;`);
  const w = await world(db);
  const calls = async () => Number((await one<number>(db, `select count(*)::int as n from net.calls`)).n);
  await db.query(`select app_private.notify_wake()`);
  assert.equal(await calls(), 0, 'nothing waits');
  await alert(db, w, 3, 'bea');
  await db.query(`update app_private.settings set key = 'notify_url_off' where key = 'notify_url'`);
  await db.query(`select app_private.notify_wake()`);
  assert.equal(await calls(), 0, 'not set up');
  await db.query(`update app_private.settings set key = 'notify_url' where key = 'notify_url_off'`);
  await db.query(`select app_private.notify_wake()`);
  assert.equal(await calls(), 1);
  const call = await one<unknown>(db, `select url, headers from net.calls`);
  assert.equal(call.url, 'https://project.supabase.co/functions/v1/notify');
  assert.deepEqual(call.headers, { 'Content-Type': 'application/json', 'x-notify-secret': w.secret });
  await claim(db, w.secret); // being tried: not woken again until it is due
  await db.query(`select app_private.notify_wake()`);
  assert.equal(await calls(), 1);
});
