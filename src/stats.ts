// Numbers for the trainer's Month tab beyond the monthly tiles: how this month compares with the last,
// the weekly rhythm, and the pack payments to hand to the accountant. Plain data in, plain data out.
import { addDays, localParts, zonedToUtc, type Booking, type Client, type PackPurchase } from './domain.ts';

const DAY = 86_400_000;

/** A moment in the previous calendar month of the trainer, to ask monthStats() about it. */
export function lastMonth(now: number, tz: string): number {
  const first = `${localParts(now, tz).date.slice(0, 7)}-01`;
  return zonedToUtc(addDays(first, -1), '12:00', tz) ?? now - 30 * DAY;
}

/** A moment in the calendar month `back` months before the one of `now` (0 is this month). */
export function monthsBack(now: number, back: number, tz: string): number {
  let at = now;
  for (let i = 0; i < back; i++) at = lastMonth(at, tz);
  return at;
}

/**
 * Pack revenue in cents for the month of `at`, voided packs left out. With `upToDay`, only the packs paid up to
 * that day of the month: this month so far against the same days of the month before, an honest comparison.
 */
export function packRevenue(packs: readonly PackPurchase[], at: number, tz: string, upToDay: number | null = null): number {
  const month = localParts(at, tz).date.slice(0, 7);
  let sum = 0;
  for (const p of packs) {
    if (p.voidedAt) continue;
    const d = localParts(Date.parse(p.paidAt), tz).date;
    if (d.slice(0, 7) === month && (upToDay === null || Number(d.slice(8)) <= upToDay)) sum += p.priceCents ?? 0;
  }
  return sum;
}

/** The change between two numbers in whole percent, or null when there is nothing to compare with. */
export function percentChange(current: number, before: number): number | null {
  return before > 0 ? Math.round(((current - before) / before) * 100) : null;
}

export interface Week {
  /** The Monday of the week, YYYY-MM-DD in the trainer's calendar. */
  start: string;
  sessions: number;
  current: boolean;
}

/** Sessions per week (Monday to Sunday) over the last `weeks` weeks, this one included: held, no-show or still booked. */
export function weeklySessions(bookings: readonly Booking[], now: number, tz: string, weeks = 8): Week[] {
  const today = localParts(now, tz);
  const thisMonday = addDays(today.date, -(today.weekday - 1));
  const starts = Array.from({ length: weeks }, (_, i) => addDays(thisMonday, -7 * (weeks - 1 - i)));
  const counts = new Map(starts.map((s) => [s, 0]));
  for (const b of bookings) {
    if (b.status !== 'attended' && b.status !== 'booked' && b.status !== 'no_show') continue;
    const d = localParts(Date.parse(b.startsAt), tz);
    const monday = addDays(d.date, -(d.weekday - 1));
    const n = counts.get(monday);
    if (n !== undefined) counts.set(monday, n + 1);
  }
  return starts.map((start) => ({ start, sessions: counts.get(start)!, current: start === thisMonday }));
}

export interface PaymentLine {
  /** YYYY-MM-DD, the trainer's calendar. */
  date: string;
  client: string;
  credits: number;
  amountCents: number | null;
  method: string;
  voided: boolean;
}

/** The packs paid in the month of `now`, oldest first, voided ones included and marked: what the accountant needs. */
export function monthPayments(packs: readonly PackPurchase[], clients: readonly Client[], now: number, tz: string): PaymentLine[] {
  const month = localParts(now, tz).date.slice(0, 7);
  const name = new Map(clients.map((c) => [c.id, c.name]));
  return packs
    .filter((p) => localParts(Date.parse(p.paidAt), tz).date.slice(0, 7) === month)
    .sort((a, b) => a.paidAt.localeCompare(b.paidAt))
    .map((p) => ({
      date: localParts(Date.parse(p.paidAt), tz).date,
      client: name.get(p.clientId) ?? '',
      credits: p.credits,
      amountCents: p.priceCents,
      method: p.method,
      voided: !!p.voidedAt,
    }));
}
