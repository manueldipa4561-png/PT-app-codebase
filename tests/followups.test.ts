// The trainer's follow-ups: who to remind, whose pack is about to end, who went quiet, who waits for a place that opened.
// Plain data in, lists out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWord, openSeats, quietClients, renewals, upcomingReminders, waLink, waNumber } from '../src/followups.ts';
import type { Booking, BookingStatus, Client, LedgerEntry, WaitlistEntry } from '../src/domain.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-01T10:00:00+02:00');
const iso = (ms: number) => new Date(ms).toISOString();

const client = (id: string, over: Partial<Client> = {}): Client => ({
  id, trainerId: 'T', userId: `u-${id}`, name: `Client ${id}`, email: null, phone: null, referralCode: id.toUpperCase().padEnd(4, 'X'),
  termsAcceptedAt: null, termsVersion: null, createdAt: iso(NOW - 90 * DAY), deletedAt: null, ...over,
});
const pack = (clientId: string, daysAgo: number, delta = 10): LedgerEntry => ({ id: `p-${clientId}-${daysAgo}`, trainerId: 'T', clientId, delta, reason: 'pack', createdAt: iso(NOW - daysAgo * DAY) });
const used = (clientId: string, n: number): LedgerEntry => ({ id: `u-${clientId}`, trainerId: 'T', clientId, delta: -n, reason: 'booking', createdAt: iso(NOW - DAY) });
const booking = (clientId: string, startsAt: number, status: BookingStatus = 'booked'): Booking => ({
  id: `b-${clientId}-${startsAt}`, trainerId: 'T', clientId, sessionTypeId: 'S', startsAt: iso(startsAt), endsAt: iso(startsAt + HOUR), location: null,
  status, bookedBy: 'client', createdAt: iso(startsAt - DAY), cancelledAt: null,
});

test('renewals: a pack with 2 or fewer sessions left, the emptiest first; sessions owed count too', () => {
  const clients = [client('a'), client('b'), client('c'), client('d'), client('e')];
  const ledger = [
    pack('a', 30), used('a', 8), // 2 left
    pack('b', 30), used('b', 10), // 0 left
    pack('c', 30), used('c', 3), // 7 left: fine
    pack('d', 30), used('d', 12), // 2 owed
    // e never bought a pack: not a renewal, just a new client
  ];
  assert.deepEqual(renewals(clients, ledger).map((r) => [r.client.id, r.balance]), [['d', -2], ['b', 0], ['a', 2]]);
});

test('renewals skip deleted clients', () => {
  const clients = [client('a', { deletedAt: iso(NOW - DAY) })];
  assert.deepEqual(renewals(clients, [pack('a', 30), used('a', 10)]), []);
});

test('quiet: nothing booked and last seen 14+ days ago, longest away first', () => {
  const clients = [client('a'), client('b'), client('c'), client('d')];
  const ledger = [pack('a', 60), pack('b', 60), pack('c', 60), pack('d', 60)];
  const bookings = [
    booking('a', NOW - 20 * DAY, 'attended'), // 20 days ago: quiet
    booking('b', NOW - 15 * DAY, 'attended'), // 15 days ago: quiet
    booking('c', NOW - 3 * DAY, 'attended'), // seen this week
    booking('d', NOW - 40 * DAY, 'attended'), booking('d', NOW + 2 * DAY), // has a session coming
  ];
  assert.deepEqual(quietClients(clients, bookings, ledger, NOW).map((q) => [q.client.id, q.days]), [['a', 20], ['b', 15]]);
});

test('quiet: late cancels and no-shows do not count as seen, a client who never trained is measured from the pack', () => {
  const clients = [client('a'), client('b')];
  const ledger = [pack('a', 40), pack('b', 20)];
  const bookings = [booking('a', NOW - 2 * DAY, 'no_show'), booking('a', NOW - 25 * DAY, 'attended')];
  assert.deepEqual(quietClients(clients, bookings, ledger, NOW).map((q) => [q.client.id, q.days]), [['a', 25], ['b', 20]]);
});

test('quiet: someone whose pack is almost over is a renewal, not repeated here; no pack means not a customer yet', () => {
  const clients = [client('a'), client('b')];
  const ledger = [pack('a', 60), used('a', 9)]; // 1 left
  const bookings = [booking('a', NOW - 30 * DAY, 'attended'), booking('b', NOW - 30 * DAY, 'attended')];
  assert.deepEqual(quietClients(clients, bookings, ledger, NOW), []);
});

test('reminders: booked sessions in the next 48 hours only, soonest first', () => {
  const clients = [client('a'), client('b'), client('c'), client('d')];
  const bookings = [
    booking('b', NOW + 30 * HOUR), booking('a', NOW + 5 * HOUR),
    booking('c', NOW + 49 * HOUR), // too far
    booking('d', NOW - HOUR), // already started
    booking('a', NOW + 8 * HOUR, 'late_cancel'), // cancelled
  ];
  assert.deepEqual(upcomingReminders(bookings, clients, NOW).map((r) => r.client.id), ['a', 'b']);
});

test('open seats: only places that opened, soonest session first and first in line first, never someone who left', () => {
  const entry = (id: string, clientId: string, startsAt: number, position: number, open: boolean): WaitlistEntry => ({
    id, trainerId: 'T', clientId, sessionTypeId: 'S', startsAt: iso(startsAt), createdAt: iso(NOW - DAY), open, position,
  });
  const clients = [client('a'), client('b'), client('c'), client('gone', { deletedAt: iso(NOW - DAY) })];
  const waitlist = [
    entry('w4', 'b', NOW + 3 * DAY, 2, true),
    entry('w1', 'a', NOW + 3 * DAY, 1, true),
    entry('w2', 'c', NOW + DAY, 1, true),
    entry('w3', 'a', NOW + 5 * DAY, 1, false), // the session is still full: nothing to do yet
    entry('w5', 'gone', NOW + DAY, 2, true),
    entry('w6', 'a', NOW - HOUR, 1, true), // started already
    entry('w7', 'nobody', NOW + DAY, 3, true),
  ];
  assert.deepEqual(openSeats(waitlist, clients, NOW).map((s) => s.entry.id), ['w2', 'w1', 'w4']);
});

test('dayWord names today and tomorrow in the trainer calendar, whatever the device zone', () => {
  assert.equal(dayWord(iso(NOW + 2 * HOUR), NOW, 'Europe/Rome'), 'today');
  assert.equal(dayWord(iso(NOW + 20 * HOUR), NOW, 'Europe/Rome'), 'tomorrow');
  assert.equal(dayWord(iso(NOW + 3 * DAY), NOW, 'Europe/Rome'), null);
  // 21:30 UTC is already the next morning in Sydney, the same instant that is still "today" for a trainer in Rome
  assert.equal(dayWord('2026-10-01T21:30:00Z', Date.parse('2026-10-01T09:00:00Z'), 'Australia/Sydney'), 'tomorrow');
  assert.equal(dayWord('2026-10-01T21:30:00Z', Date.parse('2026-10-01T09:00:00Z'), 'Europe/Rome'), 'today');
});

test('waNumber adds 39 to Italian numbers typed without it and leaves foreign ones alone', () => {
  assert.equal(waNumber('333 123 4567'), '393331234567');
  assert.equal(waNumber('+39 333 123 4567'), '393331234567');
  assert.equal(waNumber('0039 333 123 4567'), '393331234567');
  assert.equal(waNumber('085 205 6794'), '390852056794');
  assert.equal(waNumber('+44 7700 900123'), '447700900123');
  assert.equal(waNumber(null), null);
  assert.equal(waNumber('12'), null);
});

test('waLink writes the message into the chat link, and is null without a number', () => {
  const url = new URL(waLink('333 123 4567', 'Ciao Marco! Ci vediamo domani.')!);
  assert.equal(url.pathname, '/393331234567');
  assert.equal(url.searchParams.get('text'), 'Ciao Marco! Ci vediamo domani.');
  assert.equal(waLink(null, 'x'), null);
});
