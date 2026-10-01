// What a trainer should do today besides training: remind the people coming soon (late cancels and no-shows are the
// most common money loss), offer the next pack before the current one runs out, and call back the clients who went
// quiet. Everything comes from data the trainer panel already has; nothing here talks to a server.
import { localParts, type Booking, type Client, type LedgerEntry } from './domain.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A client with a pack and `limit` sessions left or fewer (or sessions owed): time to offer the next one. */
export interface Renewal {
  client: Client;
  balance: number;
}

/** A client who bought a pack, has nothing booked, and was last here `days` days ago. */
export interface Quiet {
  client: Client;
  days: number;
}

export interface Reminder {
  booking: Booking;
  client: Client;
}

const active = (c: Client) => !c.deletedAt;

function balances(ledger: readonly LedgerEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of ledger) out.set(l.clientId, (out.get(l.clientId) ?? 0) + l.delta);
  return out;
}

/** Clients who bought a pack and are down to `limit` sessions or fewer, the emptiest first. */
export function renewals(clients: readonly Client[], ledger: readonly LedgerEntry[], limit = 2): Renewal[] {
  const bought = new Set(ledger.filter((l) => l.reason === 'pack').map((l) => l.clientId));
  const bal = balances(ledger);
  return clients
    .filter((c) => active(c) && bought.has(c.id))
    .map((client) => ({ client, balance: bal.get(client.id) ?? 0 }))
    .filter((x) => x.balance <= limit)
    .sort((a, b) => a.balance - b.balance || a.client.name.localeCompare(b.client.name));
}

/**
 * Clients with a pack and no session booked, last seen `minDays` days ago or more, longest away first.
 * Someone already in the renewals list is not repeated: "your pack is over" is the better message to send.
 */
export function quietClients(
  clients: readonly Client[],
  bookings: readonly Booking[],
  ledger: readonly LedgerEntry[],
  now: number,
  minDays = 14,
  renewalLimit = 2,
): Quiet[] {
  const firstPack = new Map<string, number>();
  for (const l of ledger) {
    if (l.reason === 'pack') firstPack.set(l.clientId, Math.min(firstPack.get(l.clientId) ?? Infinity, Date.parse(l.createdAt)));
  }
  const bal = balances(ledger);
  const upcoming = new Set<string>();
  const lastSeen = new Map<string, number>();
  for (const b of bookings) {
    const at = Date.parse(b.startsAt);
    if (b.status === 'booked' && at > now) upcoming.add(b.clientId);
    else if ((b.status === 'attended' || b.status === 'booked') && at <= now) lastSeen.set(b.clientId, Math.max(lastSeen.get(b.clientId) ?? 0, at));
  }
  const out: Quiet[] = [];
  for (const client of clients) {
    if (!active(client) || !firstPack.has(client.id) || upcoming.has(client.id)) continue;
    if ((bal.get(client.id) ?? 0) <= renewalLimit) continue;
    const since = Math.max(lastSeen.get(client.id) ?? 0, firstPack.get(client.id)!);
    const days = Math.floor((now - since) / DAY);
    if (days >= minDays) out.push({ client, days });
  }
  return out.sort((a, b) => b.days - a.days || a.client.name.localeCompare(b.client.name));
}

/** Booked sessions starting in the next `hours` hours, soonest first: the people to remind. */
export function upcomingReminders(bookings: readonly Booking[], clients: readonly Client[], now: number, hours = 48): Reminder[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const out: Reminder[] = [];
  for (const booking of bookings) {
    const at = Date.parse(booking.startsAt);
    const client = byId.get(booking.clientId);
    if (booking.status === 'booked' && at > now && at <= now + hours * HOUR && client && active(client)) out.push({ booking, client });
  }
  return out.sort((a, b) => a.booking.startsAt.localeCompare(b.booking.startsAt));
}

/** "oggi", "domani" or null (the caller then names the weekday) for a session, in the trainer's calendar. */
export function dayWord(startsAt: string, now: number, tz: string): 'today' | 'tomorrow' | null {
  const day = localParts(Date.parse(startsAt), tz).date;
  const today = localParts(now, tz).date;
  if (day === today) return 'today';
  const tomorrow = localParts(now + DAY, tz).date;
  return day === tomorrow ? 'tomorrow' : null;
}

/**
 * The number WhatsApp needs: digits only, with Italy's 39 added when the trainer typed it without
 * (Italian mobiles start with 3, landlines with 0). A number that already has a country code is left alone.
 * ponytail: Italy only; other countries need their own rule when the first trainer outside Italy signs.
 */
export function waNumber(phone: string | null | undefined): string | null {
  let digits = (phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if ((digits.startsWith('3') && digits.length === 10) || (digits.startsWith('0') && digits.length >= 6 && digits.length <= 11)) digits = `39${digits}`;
  return digits.length >= 8 ? digits : null;
}

/** A WhatsApp chat with the message already written, or null when the client has no usable number. */
export function waLink(phone: string | null | undefined, text: string): string | null {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}
