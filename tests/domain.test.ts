import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  balanceOf,
  cancelOutcome,
  freeSlots,
  googleCalendarUrl,
  icsEvent,
  isoWeekday,
  localParts,
  monthStats,
  slotStatus,
  whatsappLink,
  zonedToUtc,
  type Availability,
  type Booking,
  type SessionType,
} from '../src/domain.ts';
import { brandTextOn, contrastRatio, readableOn } from '../src/theme.ts';

const TZ = 'Europe/Rome';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

test('zonedToUtc converts Rome wall time in winter and in summer', () => {
  assert.equal(iso(zonedToUtc('2026-01-15', '09:00', TZ)), '2026-01-15T08:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-07-15', '09:00', TZ)), '2026-07-15T07:00:00.000Z');
});

test('zonedToUtc returns null for the hour that does not exist on spring-forward day', () => {
  assert.equal(zonedToUtc('2026-03-29', '02:30', TZ), null);
  assert.equal(iso(zonedToUtc('2026-03-29', '03:00', TZ)), '2026-03-29T01:00:00.000Z');
});

test('zonedToUtc resolves the repeated hour on fall-back day to a real instant', () => {
  const ms = zonedToUtc('2026-10-25', '02:30', TZ);
  assert.ok(ms === Date.parse('2026-10-25T00:30:00Z') || ms === Date.parse('2026-10-25T01:30:00Z'));
  assert.equal(localParts(ms!, TZ).time, '02:30');
});

test('addDays crosses month ends and isoWeekday counts Monday as 1', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(isoWeekday('2026-09-28'), 1);
  assert.equal(isoWeekday('2026-10-04'), 7);
});

const rules = { timezone: TZ, slotStepMinutes: 30, minNoticeHours: 2, bookingHorizonDays: 28 };
const oneToOne: SessionType = { id: 't1', trainerId: 'T', name: '1:1', minutes: 60, capacity: 1, credits: 1, active: true, sort: 0 };
const group: SessionType = { ...oneToOne, id: 't2', name: 'Group', capacity: 2 };
const monday: Availability = { id: 'a1', trainerId: 'T', weekday: 1, start: '07:00', end: '09:00', location: 'Gym', sessionTypeId: null };
const NOW = Date.parse('2026-10-04T12:00:00Z');
const base = { rules, type: oneToOne, availability: [monday], timeOff: [], bookings: [] as Booking[], from: '2026-10-05', days: 1, now: NOW };
const starts = (q: Parameters<typeof freeSlots>[0]) => freeSlots(q).map((s) => s.startsAt);

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'b1', trainerId: 'T', clientId: 'c1', sessionTypeId: 't1',
  startsAt: '2026-10-05T05:00:00.000Z', endsAt: '2026-10-05T06:00:00.000Z',
  location: null, status: 'booked', bookedBy: 'client', createdAt: '2026-10-01T00:00:00.000Z', cancelledAt: null,
  ...over,
});

test('freeSlots: the whole session fits in the window, on the step grid', () => {
  assert.deepEqual(starts(base), ['2026-10-05T05:00:00.000Z', '2026-10-05T05:30:00.000Z', '2026-10-05T06:00:00.000Z']);
  assert.equal(freeSlots(base)[0].location, 'Gym');
});

test('freeSlots: minimum notice and booking horizon', () => {
  assert.deepEqual(starts({ ...base, now: Date.parse('2026-10-05T04:00:00Z') }), ['2026-10-05T06:00:00.000Z']);
  assert.deepEqual(starts({ ...base, now: Date.parse('2026-09-01T00:00:00Z') }), []);
});

test('freeSlots: time off removes every overlapping start', () => {
  const off = { id: 'o1', trainerId: 'T', startsAt: '2026-10-05T05:30:00Z', endsAt: '2026-10-05T06:00:00Z', note: null };
  assert.deepEqual(starts({ ...base, timeOff: [off] }), ['2026-10-05T06:00:00.000Z']);
});

test('freeSlots: a booked 1:1 blocks overlapping starts, cancelled and late-cancelled ones do not', () => {
  assert.deepEqual(starts({ ...base, bookings: [booking()] }), ['2026-10-05T06:00:00.000Z']);
  assert.equal(freeSlots({ ...base, bookings: [booking({ status: 'cancelled' })] }).length, 3);
  assert.equal(freeSlots({ ...base, bookings: [booking({ status: 'late_cancel' })] }).length, 3);
});

test('freeSlots: group places count down, and different session types never overlap', () => {
  const g = { ...base, type: group };
  const first = booking({ sessionTypeId: 't2' });
  const withOne = freeSlots({ ...g, bookings: [first] });
  assert.deepEqual(withOne.map((s) => s.startsAt), ['2026-10-05T05:00:00.000Z', '2026-10-05T06:00:00.000Z']);
  assert.equal(withOne[0].placesLeft, 1);
  const full = starts({ ...g, bookings: [first, booking({ id: 'b2', clientId: 'c2', sessionTypeId: 't2' })] });
  assert.deepEqual(full, ['2026-10-05T06:00:00.000Z']);
  assert.deepEqual(starts({ ...g, bookings: [booking()] }), ['2026-10-05T06:00:00.000Z']);
});

test('freeSlots: a window can be reserved for one session type', () => {
  const groupOnly = { ...monday, sessionTypeId: 't2' };
  assert.equal(freeSlots({ ...base, availability: [groupOnly] }).length, 0);
  assert.equal(freeSlots({ ...base, type: group, availability: [groupOnly] }).length, 3);
});

test('freeSlots: correct UTC across the spring-forward weekend', () => {
  const saturday: Availability = { ...monday, id: 'a6', weekday: 6, start: '09:00', end: '10:00' };
  const sunday: Availability = { ...saturday, id: 'a7', weekday: 7 };
  const q = { ...base, availability: [saturday, sunday], from: '2026-03-28', days: 2, now: Date.parse('2026-03-20T00:00:00Z') };
  assert.deepEqual(starts(q), ['2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z']);
});

test('slotStatus names the reason a start cannot be booked', () => {
  const at = (s: string) => Date.parse(s);
  assert.equal(slotStatus(base, at('2026-10-05T05:00:00Z')), 'ok');
  assert.equal(slotStatus({ ...base, now: at('2026-10-05T04:00:00Z') }, at('2026-10-05T05:00:00Z')), 'TOO_SOON');
  assert.equal(slotStatus({ ...base, now: at('2026-09-01T00:00:00Z') }, at('2026-10-05T05:00:00Z')), 'TOO_FAR');
  assert.equal(slotStatus(base, at('2026-10-05T05:15:00Z')), 'OUTSIDE_HOURS');
  assert.equal(slotStatus(base, at('2026-10-05T10:00:00Z')), 'OUTSIDE_HOURS');
  assert.equal(slotStatus({ ...base, bookings: [booking()] }, at('2026-10-05T05:30:00Z')), 'SLOT_TAKEN');
});

test('cancelOutcome: refund outside the window, late cancel inside it, nothing after the start', () => {
  const b = booking();
  const start = Date.parse(b.startsAt);
  const h = 3_600_000;
  assert.deepEqual(cancelOutcome(b, false, start - 25 * h, 24), { status: 'cancelled', refund: true });
  assert.deepEqual(cancelOutcome(b, false, start - 24 * h, 24), { status: 'cancelled', refund: true });
  assert.deepEqual(cancelOutcome(b, false, start - 23 * h, 24), { status: 'late_cancel', refund: false });
  assert.equal(cancelOutcome(b, false, start, 24), 'NOT_ALLOWED');
  assert.deepEqual(cancelOutcome(b, true, start + h, 24), { status: 'cancelled', refund: true });
  assert.equal(cancelOutcome({ ...b, status: 'cancelled' }, false, start - 48 * h, 24), 'NOT_FOUND');
});

test('balanceOf sums one client only', () => {
  const ledger = [
    { clientId: 'c1', delta: 10 },
    { clientId: 'c1', delta: -1 },
    { clientId: 'c2', delta: 5 },
  ];
  assert.equal(balanceOf(ledger, 'c1'), 9);
  assert.equal(balanceOf(ledger, 'nobody'), 0);
});

test('monthStats counts this month in the trainer time zone', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const stats = monthStats(
    {
      bookings: [
        booking({ id: 'x1', status: 'attended', startsAt: '2026-10-02T05:00:00.000Z' }),
        booking({ id: 'x2', status: 'late_cancel', startsAt: '2026-10-03T05:00:00.000Z' }),
        booking({ id: 'x3', status: 'booked', bookedBy: 'trainer', startsAt: '2026-10-28T05:00:00.000Z' }),
        booking({ id: 'x4', status: 'cancelled', startsAt: '2026-10-04T05:00:00.000Z' }),
        // 00:30 on 1 October in Rome, still 30 September in UTC
        booking({ id: 'x5', status: 'attended', startsAt: '2026-09-30T22:30:00.000Z' }),
      ],
      clients: [],
      referrals: [],
      packs: [
        { id: 'p1', trainerId: 'T', clientId: 'c1', credits: 10, priceCents: 45000, method: 'cash', paidAt: '2026-10-01T09:00:00.000Z', note: null, opId: 'o1', voidedAt: null },
        { id: 'p2', trainerId: 'T', clientId: 'c2', credits: 10, priceCents: 45000, method: 'cash', paidAt: '2026-10-01T09:00:00.000Z', note: null, opId: 'o2', voidedAt: '2026-10-02T00:00:00.000Z' },
      ],
      visits: [
        { trainerId: 'T', day: '2026-09-30', opens: 50, installed: 50 }, // last month: not counted
        { trainerId: 'T', day: '2026-10-01', opens: 12, installed: 6 },
        { trainerId: 'T', day: '2026-10-20', opens: 8, installed: 6 },
      ],
    },
    now,
    TZ,
  );
  assert.equal(stats.sessionsDone, 2);
  assert.equal(stats.lateCancels, 1);
  assert.equal(stats.upcoming, 1);
  assert.equal(stats.selfBookedShare, 3 / 4);
  assert.equal(stats.packsSold, 1);
  assert.equal(stats.packRevenueCents, 45000);
  assert.equal(stats.opens, 20);
  assert.equal(stats.installedShare, 12 / 20);
});

test('icsEvent writes UTC times, escapes text and folds long lines', () => {
  const ics = icsEvent({
    uid: 'b1@pt-app',
    title: 'Personal 1:1, con Marco; sala 2',
    description: 'Porta acqua\nE un asciugamano. '.repeat(6),
    location: 'Palestra Navigli',
    startsAt: '2026-10-05T05:00:00.000Z',
    endsAt: '2026-10-05T06:00:00.000Z',
    stamp: '2026-10-01T10:00:00.000Z',
  });
  assert.match(ics, /\r\nDTSTART:20261005T050000Z\r\n/);
  assert.match(ics, /SUMMARY:Personal 1:1\\, con Marco\\; sala 2/);
  assert.match(ics, /DESCRIPTION:Porta acqua\\nE un asciugamano/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test('googleCalendarUrl encodes UTC dates', () => {
  const url = googleCalendarUrl({ title: 'Duo', startsAt: '2026-10-05T05:00:00.000Z', endsAt: '2026-10-05T06:00:00.000Z' });
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'));
  assert.ok(url.includes('dates=20261005T050000Z%2F20261005T060000Z'));
});

test('whatsappLink keeps digits only', () => {
  assert.equal(whatsappLink('+39 333 123 4567', 'Ciao!'), 'https://wa.me/393331234567?text=Ciao!');
  assert.equal(whatsappLink(null, 'a b'), 'https://wa.me/?text=a%20b');
});

test('theme contrast picks readable ink for any brand color', () => {
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#000000') - 21) < 0.01);
  assert.equal(readableOn('#CBF24A'), '#0B0B0C');
  assert.equal(readableOn('#1F4BFF'), '#FFFFFF');
  assert.ok(contrastRatio(brandTextOn('#CBF24A', '#F4F6FA', '#0A1330'), '#F4F6FA') >= 4.5);
  assert.equal(brandTextOn('#1F4BFF', '#F4F6FA', '#0A1330'), '#1F4BFF');
});
