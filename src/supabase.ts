// The production data source: the same Api as src/demo.ts, backed by Supabase. The rules live in
// the SQL (supabase/migrations): every credit move goes through its SECURITY DEFINER functions and
// row level security scopes every read. This file only calls them, maps snake_case rows to the
// domain types and maps failures to the same AppError codes the demo throws.
import { createClient, isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import {
  AppError,
  ERROR_CODES,
  isEmail,
  type Booking,
  type BookingStatus,
  type Client,
  type LedgerEntry,
  type LedgerReason,
  type Locale,
  type PackPurchase,
  type PayMethod,
  type Plan,
  type Product,
  type Referral,
  type ReferralStatus,
  type SessionType,
  type Slot,
  type TemplateId,
  type Theme,
  type TimeOff,
  type TrainerPublic,
} from './domain.ts';
import type { Api, ReferralView } from './api.ts';

type Row = Record<string, unknown>;
type Call = PromiseLike<{ data?: unknown; error?: unknown }>;

// PostgREST caps every response at max_rows (1000 on Supabase), so lists are read page by page.
// ponytail: assumes max_rows >= PAGE; with a lower cap a read stops at its first short page.
const PAGE = 1000;
const DAY = 86_400_000;

// ── rows to domain types ────────────────────────────────────────────────────

const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);
const strOrNull = (v: unknown) => (v == null ? null : String(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
// Timestamps in the demo's exact format (toISOString). Postgres sends microseconds and drops
// trailing zeros: the fraction becomes 3 digits first, the one form every JS engine must parse.
const iso = (v: unknown) => new Date(String(v).replace(/\.(\d+)/, (_, f: string) => `.${f.slice(0, 3).padEnd(3, '0')}`)).toISOString();
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A function's single row: PostgREST sends an object, or an array for set-returning functions. */
const firstRow = (data: unknown): Row | null => {
  const r = Array.isArray(data) ? data[0] : data;
  return isRow(r) ? r : null;
};

const toTrainer = (r: Row): TrainerPublic => ({
  id: str(r.id),
  slug: str(r.slug),
  name: str(r.name),
  tagline: str(r.tagline),
  template: str(r.template) as TemplateId,
  theme: r.theme as Theme,
  plan: str(r.plan) as Plan,
  whatsapp: strOrNull(r.whatsapp),
  instagram: strOrNull(r.instagram),
  timezone: str(r.timezone),
  locale: str(r.locale) as Locale,
  currency: str(r.currency),
  slotStepMinutes: num(r.slot_step_minutes),
  minNoticeHours: num(r.min_notice_hours),
  bookingHorizonDays: num(r.booking_horizon_days),
  cancelWindowHours: num(r.cancel_window_hours),
  bonusReferrer: num(r.bonus_referrer),
  bonusReferred: num(r.bonus_referred),
  termsVersion: num(r.terms_version),
});

const toSessionType = (r: Row): SessionType => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  name: str(r.name),
  description: strOrNull(r.description),
  minutes: num(r.minutes),
  capacity: num(r.capacity),
  credits: num(r.credits),
  active: r.active === true,
  sort: num(r.sort),
});

const toProduct = (r: Row): Product => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  name: str(r.name),
  description: strOrNull(r.description),
  priceCents: num(r.price_cents),
  imageUrl: strOrNull(r.image_url),
  paymentUrl: str(r.payment_url),
  active: r.active === true,
  sort: num(r.sort),
});

const toClient = (r: Row): Client => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  userId: strOrNull(r.user_id),
  name: str(r.name),
  email: strOrNull(r.email),
  phone: strOrNull(r.phone),
  referralCode: str(r.referral_code),
  termsAcceptedAt: isoOrNull(r.terms_accepted_at),
  termsVersion: numOrNull(r.terms_version),
  createdAt: iso(r.created_at),
  deletedAt: isoOrNull(r.deleted_at),
});

const toBooking = (r: Row): Booking => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  clientId: str(r.client_id),
  sessionTypeId: str(r.session_type_id),
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  location: strOrNull(r.location),
  status: str(r.status) as BookingStatus,
  bookedBy: str(r.booked_by) as Booking['bookedBy'],
  createdAt: iso(r.created_at),
  cancelledAt: isoOrNull(r.cancelled_at),
});

const toLedger = (r: Row): LedgerEntry => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  clientId: str(r.client_id),
  delta: num(r.delta),
  reason: str(r.reason) as LedgerReason,
  bookingId: strOrNull(r.booking_id),
  packId: strOrNull(r.pack_id),
  referralId: strOrNull(r.referral_id),
  note: strOrNull(r.note),
  opId: strOrNull(r.op_id),
  createdAt: iso(r.created_at),
});

const toPack = (r: Row): PackPurchase => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  clientId: str(r.client_id),
  credits: num(r.credits),
  priceCents: numOrNull(r.price_cents),
  method: str(r.method) as PayMethod,
  paidAt: iso(r.paid_at),
  note: strOrNull(r.note),
  opId: str(r.op_id),
  voidedAt: isoOrNull(r.voided_at),
});

const toReferral = (r: Row): Referral => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  referrerClientId: str(r.referrer_client_id),
  referredClientId: str(r.referred_client_id),
  status: str(r.status) as ReferralStatus,
  createdAt: iso(r.created_at),
  rewardedAt: isoOrNull(r.rewarded_at),
  reversedAt: isoOrNull(r.reversed_at),
});

const toReferralView = (r: Row): ReferralView => ({
  id: str(r.id),
  name: str(r.name),
  status: str(r.status) as ReferralStatus,
  createdAt: iso(r.created_at),
  rewardedAt: isoOrNull(r.rewarded_at),
});

const toTimeOff = (r: Row): TimeOff => ({
  id: str(r.id),
  trainerId: str(r.trainer_id),
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  note: strOrNull(r.note),
});

const toSlot = (r: Row): Slot => ({
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  placesLeft: num(r.places_left),
  location: strOrNull(r.location),
});

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * The one error mapper. A SQL `raise exception 'NO_CREDITS'` arrives as the message and becomes
 * that AppError; auth limits, bad codes and network failures get their codes; anything else is
 * rethrown with the operation name, never swallowed.
 */
function toAppError(op: string, e: unknown): Error {
  if (e instanceof AppError) return e;
  const get = (k: string): unknown => (typeof e === 'object' && e !== null && k in e ? (e as Row)[k] : undefined);
  const message = String(get('message') ?? e).trim();
  const code = get('code');
  const known = ERROR_CODES.find((c) => c === message);
  if (known) return new AppError(known);
  if (get('status') === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return new AppError('RATE_LIMITED');
  if (code === 'otp_expired' || /expired or is invalid/i.test(message)) return new AppError('INVALID_CODE');
  // fetch rejects with a TypeError; postgrest-js reports it as "TypeError: ...", auth-js as status 0
  if (e instanceof TypeError || (get('name') === 'AuthRetryableFetchError' && get('status') === 0) || /^TypeError:|Failed to fetch/.test(message)) {
    return new AppError('NETWORK');
  }
  return new Error(`${op}: ${message}`, { cause: e });
}

// ── the api ─────────────────────────────────────────────────────────────────

export function createSupabaseApi(url: string, anonKey: string): Api {
  const sb = createClient(url, anonKey);

  /** Awaits one Supabase call. Every failure, returned or thrown, goes through toAppError. */
  async function run(op: string, call: Call): Promise<unknown> {
    let res: Awaited<Call>;
    try {
      res = await call;
    } catch (e) {
      throw toAppError(op, e);
    }
    if (res.error) throw toAppError(op, res.error);
    return res.data;
  }
  async function row(op: string, call: Call): Promise<Row> {
    const r = firstRow(await run(op, call));
    if (!r) throw new Error(`${op}: no row returned`);
    return r;
  }
  /** Every row of a list. `page` builds a fresh, fully ordered query for one range. */
  async function all(op: string, page: (from: number, to: number) => Call): Promise<Row[]> {
    const out: Row[] = [];
    for (;;) {
      const data = await run(op, page(out.length, out.length + PAGE - 1));
      const rows = Array.isArray(data) ? data.filter(isRow) : [];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  // RLS shows a trainers row only to its owner.
  const owns = async (op: string, trainerId: string) =>
    firstRow(await run(op, sb.from('trainers').select('id').eq('id', trainerId).maybeSingle())) !== null;
  const clientOf = async (op: string, trainerId: string, userId: string) => {
    const r = firstRow(
      await run(op, sb.from('clients').select('*').eq('trainer_id', trainerId).eq('user_id', userId).is('deleted_at', null).maybeSingle()),
    );
    return r && toClient(r);
  };
  /** The signed-in user's client record here; null when signed out or not a client. */
  async function myClient(op: string, trainerId: string): Promise<Client | null> {
    const { data, error } = await sb.auth.getSession();
    if (error) throw toAppError(op, error);
    return data.session ? clientOf(op, trainerId, data.session.user.id) : null;
  }

  return {
    mode: 'live',

    async getTrainer(key) {
      const r = firstRow(await run('getTrainer', sb.rpc('trainer_public', { p_key: key })));
      if (!r) throw new AppError('TENANT_NOT_FOUND', key);
      return toTrainer(r);
    },
    async sessionTypes(trainerId) {
      const rows = await all('sessionTypes', (from, to) =>
        sb.from('session_types').select('*').eq('trainer_id', trainerId).eq('active', true).order('sort').order('id').range(from, to),
      );
      return rows.map(toSessionType);
    },
    async products(trainerId) {
      const rows = await all('products', (from, to) =>
        sb.from('products').select('*').eq('trainer_id', trainerId).eq('active', true).order('sort').order('id').range(from, to),
      );
      return rows.map(toProduct);
    },

    async sendCode(email) {
      const e = email.trim();
      if (!isEmail(e)) throw new AppError('INVALID_INPUT', 'email'); // same check as the demo
      await run('sendCode', sb.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } }));
    },
    async verifyCode(email, code) {
      await run('verifyCode', sb.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' }));
    },
    async signOut() {
      await run('signOut', sb.auth.signOut({ scope: 'local' }));
    },
    async me(trainerId) {
      const { data, error } = await sb.auth.getUser();
      // No session, or one the server no longer accepts (signed out elsewhere, user deleted): anonymous.
      const signedOut = isAuthSessionMissingError(error) || (isAuthApiError(error) && error.status < 500 && error.status !== 429);
      if (error && !signedOut) throw toAppError('me', error);
      const user = data.user;
      if (!user) return { userId: null, email: null, client: null, isOwner: false };
      const [client, isOwner] = await Promise.all([clientOf('me', trainerId, user.id), owns('me', trainerId)]);
      return { userId: user.id, email: user.email ?? null, client, isOwner };
    },
    async join(trainerId, input) {
      const r = await row(
        'join',
        sb.rpc('join_trainer', {
          p_trainer: trainerId,
          p_name: input.name,
          p_phone: input.phone ?? null,
          p_referral_code: input.referralCode ?? null,
          p_accept_terms: input.acceptTerms,
        }),
      );
      return toClient(r);
    },

    async myLedger(trainerId) {
      const c = await myClient('myLedger', trainerId);
      if (!c) return [];
      const rows = await all('myLedger', (from, to) =>
        sb.from('credit_ledger').select('*').eq('client_id', c.id).order('created_at', { ascending: false }).order('id').range(from, to),
      );
      return rows.map(toLedger);
    },
    async myBookings(trainerId) {
      const c = await myClient('myBookings', trainerId);
      if (!c) return [];
      const rows = await all('myBookings', (from, to) =>
        sb.from('bookings').select('*').eq('client_id', c.id).order('starts_at').order('id').range(from, to),
      );
      return rows.map(toBooking);
    },
    async myReferrals(trainerId) {
      if (!(await myClient('myReferrals', trainerId))) return [];
      const rows = await all('myReferrals', (from, to) =>
        sb.rpc('my_referrals', { p_trainer: trainerId }).order('created_at', { ascending: false }).order('id').range(from, to),
      );
      return rows.map(toReferralView);
    },
    async freeSlots(sessionTypeId, from, days) {
      const rows = await all('freeSlots', (a, b) =>
        sb.rpc('free_slots', { p_session_type: sessionTypeId, p_from: from, p_days: days }).order('starts_at').range(a, b),
      );
      return rows.map(toSlot);
    },
    async book(sessionTypeId, startsAt) {
      return toBooking(await row('book', sb.rpc('book_session', { p_session_type: sessionTypeId, p_starts_at: startsAt })));
    },
    async cancel(bookingId) {
      return toBooking(await row('cancel', sb.rpc('cancel_booking', { p_booking: bookingId })));
    },
    async deleteAccount(trainerId) {
      await run('deleteAccount', sb.rpc('delete_my_account', { p_trainer: trainerId }));
      await run('deleteAccount', sb.auth.signOut({ scope: 'local' }));
    },

    async trainerData(trainerId) {
      const since = new Date(Date.now() - 120 * DAY).toISOString();
      const of = (table: string, order: string) =>
        all('trainerData', (from, to) => {
          const q = sb.from(table).select('*').eq('trainer_id', trainerId);
          return (table === 'bookings' ? q.gte('starts_at', since) : q).order(order).order('id').range(from, to);
        });
      const [owner, clients, bookings, ledger, referrals, packs, timeOff] = await Promise.all([
        owns('trainerData', trainerId),
        of('clients', 'created_at'),
        of('bookings', 'starts_at'),
        of('credit_ledger', 'created_at'),
        of('referrals', 'created_at'),
        of('pack_purchases', 'paid_at'),
        of('time_off', 'starts_at'),
      ]);
      // As in the demo. RLS alone would hand a client their own rows instead.
      if (!owner) throw new AppError('NOT_ALLOWED');
      return {
        clients: clients.map(toClient),
        bookings: bookings.map(toBooking),
        ledger: ledger.map(toLedger),
        referrals: referrals.map(toReferral),
        packs: packs.map(toPack),
        timeOff: timeOff.map(toTimeOff),
      };
    },
    async addClient(trainerId, input) {
      const r = await row(
        'addClient',
        sb.rpc('trainer_add_client', { p_trainer: trainerId, p_name: input.name, p_email: input.email ?? null, p_phone: input.phone ?? null }),
      );
      return toClient(r);
    },
    async bookFor(clientId, sessionTypeId, startsAt) {
      return toBooking(await row('bookFor', sb.rpc('trainer_book', { p_client: clientId, p_type: sessionTypeId, p_starts_at: startsAt })));
    },
    async markPackPaid(clientId, input) {
      // No SQL defaults here: every argument is sent, null included, or PostgREST finds no function.
      const r = await row(
        'markPackPaid',
        sb.rpc('mark_pack_paid', {
          p_client: clientId,
          p_credits: input.credits,
          p_price_cents: input.priceCents ?? null,
          p_method: input.method,
          p_note: input.note ?? null,
          p_op_id: input.opId,
        }),
      );
      return { packId: str(r.pack_id), rewarded: r.rewarded === true };
    },
    async voidPack(packId) {
      await run('voidPack', sb.rpc('void_pack', { p_pack: packId }));
    },
    async adjustCredits(clientId, delta, note, opId) {
      await run('adjustCredits', sb.rpc('adjust_credits', { p_client: clientId, p_delta: delta, p_note: note, p_op_id: opId }));
    },
    async setAttendance(bookingId, status) {
      return toBooking(await row('setAttendance', sb.rpc('set_attendance', { p_booking: bookingId, p_status: status })));
    },
    async reverseReferral(referralId) {
      await run('reverseReferral', sb.rpc('reverse_referral', { p_referral: referralId }));
    },
    async addTimeOff(trainerId, startsAt, endsAt, note) {
      const s = Date.parse(startsAt);
      const e = Date.parse(endsAt);
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new AppError('INVALID_INPUT', 'range'); // same check as the demo
      const r = await row(
        'addTimeOff',
        sb
          .from('time_off')
          .insert({ trainer_id: trainerId, starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), note: note?.trim() || null })
          .select()
          .single(),
      );
      return toTimeOff(r);
    },
    async removeTimeOff(id) {
      const gone = await run('removeTimeOff', sb.from('time_off').delete().eq('id', id).select('id'));
      // As in the demo. A delete that matches nothing (gone, or another trainer's) is not a success.
      if (!Array.isArray(gone) || gone.length === 0) throw new AppError('NOT_FOUND', 'time off');
    },
  };
}
