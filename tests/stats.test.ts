// The Month tab's comparisons: last month, the weekly rhythm, and the payments list for the accountant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastMonth, monthPayments, monthsBack, packRevenue, percentChange, weeklySessions } from '../src/stats.ts';
import { localParts, type Booking, type BookingStatus, type Client, type PackPurchase } from '../src/domain.ts';

const TZ = 'Europe/Rome';
const NOW = Date.parse('2026-10-01T10:00:00+02:00'); // a Thursday
const at = (iso: string) => new Date(Date.parse(iso)).toISOString();

const booking = (start: string, status: BookingStatus = 'attended'): Booking => ({
  id: start + status, trainerId: 'T', clientId: 'c', sessionTypeId: 's', startsAt: at(start), endsAt: at(start), location: null,
  status, bookedBy: 'client', createdAt: at(start), cancelledAt: null,
});
const client = (id: string, name: string): Client => ({
  id, trainerId: 'T', userId: null, name, email: null, phone: null, referralCode: id.toUpperCase().padEnd(4, 'X'),
  termsAcceptedAt: null, termsVersion: null, createdAt: at('2026-01-01T00:00:00Z'), deletedAt: null,
});
const pack = (id: string, clientId: string, paidAt: string, priceCents: number | null, voidedAt: string | null = null): PackPurchase => ({
  id, trainerId: 'T', clientId, credits: 10, priceCents, method: 'cash', paidAt: at(paidAt), note: null, opId: id, voidedAt,
});

test('lastMonth points into the previous calendar month, also at the turn of the year', () => {
  assert.equal(localParts(lastMonth(NOW, TZ), TZ).date.slice(0, 7), '2026-09');
  assert.equal(localParts(lastMonth(Date.parse('2027-01-15T12:00:00+01:00'), TZ), TZ).date.slice(0, 7), '2026-12');
  assert.equal(localParts(lastMonth(Date.parse('2026-03-01T00:30:00+01:00'), TZ), TZ).date.slice(0, 7), '2026-02');
});

test('monthsBack goes back whole calendar months', () => {
  const ym = (n: number) => localParts(monthsBack(NOW, n, TZ), TZ).date.slice(0, 7);
  assert.deepEqual([0, 1, 2, 3].map(ym), ['2026-10', '2026-09', '2026-08', '2026-07']);
  assert.equal(localParts(monthsBack(Date.parse('2026-02-10T12:00:00+01:00'), 3, TZ), TZ).date.slice(0, 7), '2025-11');
});

test('packRevenue sums the month, can stop at a day of the month, and skips voided packs', () => {
  const packs = [
    pack('1', 'a', '2026-10-01T09:00:00+02:00', 42000),
    pack('2', 'a', '2026-10-20T09:00:00+02:00', 36000),
    pack('3', 'a', '2026-09-03T09:00:00+02:00', 10000),
    pack('4', 'a', '2026-09-25T09:00:00+02:00', 20000),
    pack('5', 'a', '2026-09-02T09:00:00+02:00', 99999, '2026-09-02T10:00:00Z'), // voided
    pack('6', 'a', '2026-09-04T09:00:00+02:00', null), // no price recorded
  ];
  assert.equal(packRevenue(packs, NOW, TZ), 78000);
  assert.equal(packRevenue(packs, lastMonth(NOW, TZ), TZ), 30000);
  assert.equal(packRevenue(packs, lastMonth(NOW, TZ), TZ, 3), 10000); // September up to the 3rd
  assert.equal(packRevenue(packs, NOW, TZ, 1), 42000);
});

test('percentChange is whole percent, and null when the month before had nothing', () => {
  assert.equal(percentChange(1440, 1200), 20);
  assert.equal(percentChange(900, 1200), -25);
  assert.equal(percentChange(0, 500), -100);
  assert.equal(percentChange(500, 0), null);
});

test('weeklySessions counts Monday to Sunday weeks, this one last, and ignores cancelled sessions', () => {
  const bookings = [
    booking('2026-09-28T09:00:00+02:00'), // Monday of this week
    booking('2026-10-04T20:00:00+02:00', 'booked'), // Sunday of this week (still booked)
    booking('2026-09-27T09:00:00+02:00', 'no_show'), // Sunday, last week
    booking('2026-09-21T09:00:00+02:00'), // Monday, last week
    booking('2026-09-22T09:00:00+02:00', 'cancelled'), // not counted
    booking('2026-09-23T09:00:00+02:00', 'late_cancel'), // not counted
    booking('2026-08-01T09:00:00+02:00'), // outside the 3 weeks asked for
  ];
  const weeks = weeklySessions(bookings, NOW, TZ, 3);
  assert.deepEqual(weeks.map((w) => [w.start, w.sessions, w.current]), [
    ['2026-09-14', 0, false],
    ['2026-09-21', 2, false],
    ['2026-09-28', 2, true],
  ]);
});

test('monthPayments lists the packs paid this month in order, voided ones marked, with the client name', () => {
  const clients = [client('a', 'Anna Rossi'), client('b', 'Bruno Neri')];
  const packs = [
    pack('3', 'b', '2026-10-01T09:00:00+02:00', 36000),
    pack('1', 'a', '2026-10-01T08:00:00+02:00', 42000),
    pack('2', 'a', '2026-09-30T23:30:00+02:00', 42000), // last month
    pack('4', 'b', '2026-10-01T09:30:00+02:00', null, '2026-10-01T10:00:00Z'), // voided, no price
  ];
  assert.deepEqual(
    monthPayments(packs, clients, NOW, TZ).map((p) => [p.date, p.client, p.amountCents, p.voided]),
    [['2026-10-01', 'Anna Rossi', 42000, false], ['2026-10-01', 'Bruno Neri', 36000, false], ['2026-10-01', 'Bruno Neri', null, true]],
  );
});
