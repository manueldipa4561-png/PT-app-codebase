// Pure business rules shared by the demo data source, the UI and the tests.
// Production enforces the same rules in Postgres (supabase/migrations). The shared
// scenarios in tests/scenarios.ts run against both, so the two cannot drift silently.

export type Plan = 'web' | 'pro' | 'store';
export type TemplateId = 'studio' | 'energy' | 'luxe';
export type Locale = 'it' | 'en';
export type BookingStatus = 'booked' | 'cancelled' | 'late_cancel' | 'attended' | 'no_show';
export type LedgerReason = 'pack' | 'pack_void' | 'booking' | 'refund' | 'referral' | 'referral_reversal' | 'manual';
export type PayMethod = 'cash' | 'transfer' | 'pos' | 'satispay' | 'other';
export type ReferralStatus = 'pending' | 'rewarded' | 'reversed';
export type ErrorCode =
  | 'TENANT_NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'INVALID_CODE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_ALLOWED'
  | 'SLOT_TAKEN'
  | 'SLOT_OPEN'
  | 'NO_CREDITS'
  | 'TOO_SOON'
  | 'TOO_FAR'
  | 'OUTSIDE_HOURS';

export const ERROR_CODES: readonly ErrorCode[] = [
  'TENANT_NOT_FOUND', 'NETWORK', 'RATE_LIMITED', 'INVALID_CODE', 'INVALID_INPUT', 'NOT_FOUND',
  'NOT_ALLOWED', 'SLOT_TAKEN', 'SLOT_OPEN', 'NO_CREDITS', 'TOO_SOON', 'TOO_FAR', 'OUTSIDE_HOURS',
];

export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AppError';
    this.code = code;
  }
}

export interface Theme {
  brand: string; // #RRGGBB: buttons, highlights, the hero duotone
  accent?: string; // #RRGGBB: second tone, used by the hero shader only
  mode?: 'light' | 'dark' | 'auto';
  logo?: string; // https URL (a data: URL only inside the demo preview)
  cover?: string; // https URL of the hero photo
}

export interface TrainerPublic {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  template: TemplateId;
  theme: Theme;
  plan: Plan;
  whatsapp: string | null;
  instagram: string | null;
  timezone: string;
  locale: Locale;
  currency: string;
  slotStepMinutes: number;
  minNoticeHours: number;
  bookingHorizonDays: number;
  cancelWindowHours: number;
  bonusReferrer: number;
  bonusReferred: number;
  termsVersion: number;
}

export interface SessionType {
  id: string;
  trainerId: string;
  name: string;
  description?: string | null;
  minutes: number;
  capacity: number;
  credits: number;
  active: boolean;
  sort: number;
}

export interface Availability {
  id: string;
  trainerId: string;
  weekday: number; // ISO: 1 = Monday ... 7 = Sunday
  start: string; // HH:MM, trainer's local time
  end: string;
  location?: string | null;
  sessionTypeId?: string | null; // set = this window only offers that session type
}

export interface TimeOff {
  id: string;
  trainerId: string;
  startsAt: string;
  endsAt: string;
  note?: string | null;
}

export interface Client {
  id: string;
  trainerId: string;
  userId: string | null; // null = added by the trainer, no login yet
  name: string;
  email: string | null;
  phone: string | null;
  referralCode: string;
  termsAcceptedAt: string | null;
  termsVersion: number | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface Booking {
  id: string;
  trainerId: string;
  clientId: string;
  sessionTypeId: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  status: BookingStatus;
  bookedBy: 'client' | 'trainer';
  createdAt: string;
  cancelledAt: string | null;
}

export interface PackPurchase {
  id: string;
  trainerId: string;
  clientId: string;
  credits: number;
  priceCents: number | null;
  method: PayMethod;
  paidAt: string;
  note: string | null;
  opId: string;
  voidedAt: string | null;
}

export interface LedgerEntry {
  id: string;
  trainerId: string;
  clientId: string;
  delta: number;
  reason: LedgerReason;
  bookingId?: string | null;
  packId?: string | null;
  referralId?: string | null;
  note?: string | null;
  opId?: string | null;
  createdAt: string;
}

export interface Referral {
  id: string;
  trainerId: string;
  referrerClientId: string;
  referredClientId: string;
  status: ReferralStatus;
  createdAt: string;
  rewardedAt: string | null;
  reversedAt: string | null;
}

export interface Product {
  id: string;
  trainerId: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  paymentUrl: string;
  active: boolean;
  sort: number;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  placesLeft: number;
  location: string | null;
}

/** A client waiting for a place in a session that is full, as stored. */
export interface WaitlistRow {
  id: string;
  trainerId: string;
  clientId: string;
  sessionTypeId: string;
  startsAt: string;
  createdAt: string;
}

/** What the waiting list shows: worked out when it is read, never stored. */
export interface WaitlistEntry extends WaitlistRow {
  /** A place is free now: the client can book it (outside the minimum notice), the trainer can book it for them. */
  open: boolean;
  /** 1 is first in line, first come first served. */
  position: number;
}

// ── time: wall-clock times in the trainer's zone, stored as UTC instants ──────────

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): Record<string, string> {
  const p: Record<string, string> = {};
  for (const x of partsFormatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function localParts(ms: number, tz: string): { date: string; time: string; weekday: number } {
  const p = parts(ms, tz);
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, weekday: isoWeekday(date) };
}

function offsetMinutes(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** Local wall time -> UTC ms. Null when the time does not exist (spring-forward gap). */
export function zonedToUtc(date: string, time: string, tz: string): number | null {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - offsetMinutes(wall, tz) * MINUTE;
  const second = wall - offsetMinutes(utc, tz) * MINUTE;
  if (second !== utc) utc = second;
  const back = localParts(utc, tz);
  return back.date === date && back.time === time.slice(0, 5) ? utc : null;
}

/**
 * The same weekday and local time for the next `weeks - 1` weeks (a standing weekly slot), as UTC instants.
 * Local time is kept across a clock change, so 18:30 stays 18:30; a week where that time does not exist
 * (the hour skipped in spring) is left out.
 */
export function weeklyRepeats(startsAt: string, weeks: number, tz: string): string[] {
  const first = localParts(Date.parse(startsAt), tz);
  const out: string[] = [];
  for (let k = 1; k < weeks; k++) {
    const ms = zonedToUtc(addDays(first.date, 7 * k), first.time, tz);
    if (ms !== null) out.push(new Date(ms).toISOString());
  }
  return out;
}

const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ── slots ─────────────────────────────────────────────────────────────────────

const OCCUPYING: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['booked', 'attended', 'no_show']);

export interface SlotRules {
  timezone: string;
  slotStepMinutes: number;
  minNoticeHours: number;
  bookingHorizonDays: number;
}

export interface SlotQuery {
  rules: SlotRules;
  type: SessionType;
  availability: Availability[];
  timeOff: TimeOff[];
  bookings: Booking[]; // this trainer's bookings, any status
  from: string; // local date
  days: number;
  now: number;
}

export interface Candidate extends Slot {
  inTimeOff: boolean;
}

/** Places left for `type` at [start, end): 0 when the trainer is busy with another session. */
export function placesLeftAt(type: SessionType, bookings: Booking[], start: number, end: number): number {
  let same = 0;
  for (const b of bookings) {
    if (!OCCUPYING.has(b.status)) continue;
    const bs = Date.parse(b.startsAt);
    const be = Date.parse(b.endsAt);
    if (bs >= end || be <= start) continue;
    if (b.sessionTypeId === type.id && bs === start) same++;
    else return 0;
  }
  return Math.max(0, type.capacity - same);
}

/** Every start the availability allows, before notice/horizon filtering. */
export function candidateSlots(q: Omit<SlotQuery, 'now'>): Candidate[] {
  const { rules, type } = q;
  const seen = new Map<number, Candidate>();
  for (let d = 0; d < q.days; d++) {
    const date = addDays(q.from, d);
    const weekday = isoWeekday(date);
    for (const w of q.availability) {
      if (w.weekday !== weekday) continue;
      if (w.sessionTypeId && w.sessionTypeId !== type.id) continue;
      const last = toMinutes(w.end) - type.minutes;
      for (let m = toMinutes(w.start); m <= last; m += rules.slotStepMinutes) {
        const start = zonedToUtc(date, fromMinutes(m), rules.timezone);
        if (start === null || seen.has(start)) continue;
        const end = start + type.minutes * MINUTE;
        seen.set(start, {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
          placesLeft: placesLeftAt(type, q.bookings, start, end),
          inTimeOff: q.timeOff.some((o) => Date.parse(o.startsAt) < end && Date.parse(o.endsAt) > start),
          location: w.location ?? null,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The slots a client may book or wait for: offered, and inside the minimum notice and the booking horizon. */
function offeredSlots(q: SlotQuery): Candidate[] {
  const earliest = q.now + q.rules.minNoticeHours * HOUR;
  const latest = q.now + q.rules.bookingHorizonDays * DAY;
  return candidateSlots(q).filter((c) => {
    const s = Date.parse(c.startsAt);
    return !c.inTimeOff && s >= earliest && s <= latest;
  });
}
const asSlot = (c: Candidate): Slot => ({ startsAt: c.startsAt, endsAt: c.endsAt, placesLeft: c.placesLeft, location: c.location });

export function freeSlots(q: SlotQuery): Slot[] {
  return offeredSlots(q).filter((c) => c.placesLeft > 0).map(asSlot);
}

/** The offered slots with no place left, the ones to wait for. Never a session `clientId` already holds. */
export function fullSlots(q: SlotQuery, clientId: string | null): Slot[] {
  const held = new Set(q.bookings.filter((b) => b.clientId === clientId && b.status === 'booked').map((b) => Date.parse(b.startsAt)));
  return offeredSlots(q)
    .filter((c) => c.placesLeft === 0 && !held.has(Date.parse(c.startsAt)))
    .map(asSlot);
}

/** Why a client cannot book `start`, or 'ok'. Checked in this order by the SQL too. */
export function slotStatus(q: Omit<SlotQuery, 'from' | 'days'>, start: number): 'ok' | ErrorCode {
  if (Number.isNaN(start)) return 'INVALID_INPUT';
  if (start < q.now + q.rules.minNoticeHours * HOUR) return 'TOO_SOON';
  if (start > q.now + q.rules.bookingHorizonDays * DAY) return 'TOO_FAR';
  const iso = new Date(start).toISOString();
  const c = candidateSlots({ ...q, from: localParts(start, q.rules.timezone).date, days: 1 }).find((x) => x.startsAt === iso);
  if (!c || c.inTimeOff) return 'OUTSIDE_HOURS';
  if (c.placesLeft <= 0) return 'SLOT_TAKEN';
  return 'ok';
}

/** Why a client cannot join the waitlist of `start`, or 'ok': the booking checks, with the place taken instead of free. */
export function waitlistStatus(q: Omit<SlotQuery, 'from' | 'days'>, start: number): 'ok' | ErrorCode {
  const s = slotStatus(q, start);
  return s === 'SLOT_TAKEN' ? 'ok' : s === 'ok' ? 'SLOT_OPEN' : s;
}

/**
 * The waiting list as `viewer` may see it: the owner sees everyone's, a client only their own. Only entries that still
 * mean something: the session is ahead and still offered (`placesAt` is null when it is not), the client is still
 * here and does not already hold it. The SQL (waitlist_entries) says the same, and tests/scenarios.ts holds both to it.
 */
export function waitlistEntries(
  rows: readonly WaitlistRow[],
  ctx: {
    now: number;
    minNoticeHours: number;
    placesAt(sessionTypeId: string, start: number): number | null;
    holds(clientId: string, start: number): boolean;
    alive(clientId: string): boolean;
  },
  viewer: { owner: boolean; clientId: string | null },
): WaitlistEntry[] {
  const places = new Map<string, number | null>();
  const placesOf = (typeId: string, start: number) => {
    const key = `${typeId}|${start}`;
    if (!places.has(key)) places.set(key, ctx.placesAt(typeId, start));
    return places.get(key) ?? null;
  };
  const live = rows
    .filter((w) => {
      const start = Date.parse(w.startsAt);
      return start > ctx.now && ctx.alive(w.clientId) && !ctx.holds(w.clientId, start) && placesOf(w.sessionTypeId, start) !== null;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // a tie keeps the order the rows came in
  const inLine = new Map<string, number>();
  const out: WaitlistEntry[] = [];
  for (const w of live) {
    const start = Date.parse(w.startsAt);
    const key = `${w.sessionTypeId}|${start}`;
    const position = (inLine.get(key) ?? 0) + 1;
    inLine.set(key, position);
    if (!viewer.owner && w.clientId !== viewer.clientId) continue;
    const open = (placesOf(w.sessionTypeId, start) ?? 0) > 0 && (viewer.owner || start >= ctx.now + ctx.minNoticeHours * HOUR);
    out.push({ ...w, open, position });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.position - b.position || a.sessionTypeId.localeCompare(b.sessionTypeId) || a.id.localeCompare(b.id));
}

// ── cancellations and credits ────────────────────────────────────────────────

export type CancelOutcome = { status: 'cancelled' | 'late_cancel'; refund: boolean };

export function cancelOutcome(
  b: Pick<Booking, 'status' | 'startsAt'>,
  byTrainer: boolean,
  now: number,
  cancelWindowHours: number,
): CancelOutcome | ErrorCode {
  if (b.status !== 'booked') return 'NOT_FOUND';
  if (byTrainer) return { status: 'cancelled', refund: true };
  const start = Date.parse(b.startsAt);
  if (now >= start) return 'NOT_ALLOWED';
  if (start - now >= cancelWindowHours * HOUR) return { status: 'cancelled', refund: true };
  return { status: 'late_cancel', refund: false };
}

export function balanceOf(ledger: ReadonlyArray<Pick<LedgerEntry, 'clientId' | 'delta'>>, clientId: string): number {
  let sum = 0;
  for (const l of ledger) if (l.clientId === clientId) sum += l.delta;
  return sum;
}

// ── trainer "this month" ─────────────────────────────────────────────────────

/** Anonymous app opens on one day of the trainer's calendar (no user, no IP, no cookie). */
export interface DayVisits {
  trainerId: string;
  day: string; // YYYY-MM-DD, trainer's time zone
  opens: number;
  installed: number; // of which from the home-screen app
}

export interface MonthStats {
  sessionsDone: number;
  upcoming: number;
  selfBookedShare: number | null; // share of live bookings the clients made themselves
  newClients: number;
  viaReferral: number;
  lateCancels: number;
  noShows: number;
  packsSold: number;
  packRevenueCents: number;
  opens: number;
  installedShare: number | null; // share of opens from the home-screen app
}

export function monthStats(
  d: { bookings: Booking[]; clients: Client[]; referrals: Referral[]; packs: PackPurchase[]; visits: DayVisits[] },
  now: number,
  tz: string,
): MonthStats {
  const month = localParts(now, tz).date.slice(0, 7);
  const inMonth = (iso: string) => localParts(Date.parse(iso), tz).date.slice(0, 7) === month;
  const bookings = d.bookings.filter((b) => inMonth(b.startsAt));
  const live = bookings.filter((b) => b.status !== 'cancelled');
  const packs = d.packs.filter((p) => !p.voidedAt && inMonth(p.paidAt));
  const visits = d.visits.filter((v) => v.day.slice(0, 7) === month);
  const opens = visits.reduce((s, v) => s + v.opens, 0);
  return {
    opens,
    installedShare: opens ? visits.reduce((s, v) => s + v.installed, 0) / opens : null,
    sessionsDone: bookings.filter((b) => b.status === 'attended').length,
    upcoming: bookings.filter((b) => b.status === 'booked' && Date.parse(b.startsAt) > now).length,
    selfBookedShare: live.length ? live.filter((b) => b.bookedBy === 'client').length / live.length : null,
    newClients: d.clients.filter((c) => !c.deletedAt && inMonth(c.createdAt)).length,
    viaReferral: d.referrals.filter((r) => r.status !== 'reversed' && inMonth(r.createdAt)).length,
    lateCancels: bookings.filter((b) => b.status === 'late_cancel').length,
    noShows: bookings.filter((b) => b.status === 'no_show').length,
    packsSold: packs.length,
    packRevenueCents: packs.reduce((s, p) => s + (p.priceCents ?? 0), 0),
  };
}

// ── calendar and sharing ─────────────────────────────────────────────────────

export interface CalendarEvent {
  uid: string;
  title: string;
  description?: string;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  stamp: string;
}

const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 folding: lines of at most 75 octets, continuations start with a space. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75;
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function icsEvent(e: CalendarEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PT App//Booking//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(e.stamp)}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(e.endsAt)}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(e.title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(e: Omit<CalendarEvent, 'uid' | 'stamp'>): string {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${icsDate(e.startsAt)}/${icsDate(e.endsAt)}` });
  if (e.description) p.set('details', e.description);
  if (e.location) p.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${p}`;
}

export function whatsappLink(phone: string | null | undefined, text: string): string {
  return `https://wa.me/${(phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

// ── small validators shared by the demo and the forms ────────────────────────

export const REFERRAL_CODE = /^[A-Z0-9]{4,12}$/;
export const isEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
export const isPhone = (s: string) => /^\+?[0-9 ]{6,20}$/.test(s);
export const isHttpsUrl = (s: string) => /^https:\/\/\S+$/.test(s);
export const isHexColor = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
export const PAY_METHODS: readonly PayMethod[] = ['cash', 'transfer', 'pos', 'satispay', 'other'];

export function newReferralCode(taken: (code: string) => boolean, random: () => number = Math.random): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += '0123456789ABCDEF'[Math.floor(random() * 16)];
    if (!taken(code)) return code;
  }
}
