import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, type TrainerPublic } from '../src/domain.ts';
import { createDemoApi } from '../src/demo.ts';
import { DEMO_USER, buildSeed, emptyDB, type DemoTrainer } from '../src/seed.ts';
import { scenarios, type Harness, type Result } from './scenarios.ts';

const TRAINER_DEFAULTS: Omit<TrainerPublic, 'id' | 'slug' | 'name'> = {
  tagline: '',
  template: 'studio',
  theme: { brand: '#1F4BFF' },
  plan: 'web',
  whatsapp: null,
  instagram: null,
  timezone: 'Europe/Rome',
  locale: 'it',
  currency: 'EUR',
  slotStepMinutes: 30,
  minNoticeHours: 2,
  bookingHorizonDays: 28,
  cancelWindowHours: 24,
  bonusReferrer: 1,
  bonusReferred: 1,
  termsVersion: 1,
};

function demoHarness(): Harness {
  let now = Date.parse('2026-10-04T12:00:00.000Z');
  const api = createDemoApi({ storage: null, now: () => now, seed: () => emptyDB(now) });
  const db = api.db();
  let n = 0;
  const id = (prefix: string) => `${prefix}-${++n}`;

  async function as<T>(user: string | null, at: string | null, fn: () => Promise<T>): Promise<Result<T>> {
    api.setActor(user);
    if (at) now = Date.parse(at);
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code };
      throw e;
    }
  }

  return {
    async trainer(o = {}) {
      const t: DemoTrainer = { ...TRAINER_DEFAULTS, ...o, id: id('t'), slug: id('trainer'), name: 'Test', ownerUserId: id('owner'), domain: null };
      db.trainers.push(t);
      db.users.push({ id: t.ownerUserId, email: `${t.ownerUserId}@example.com` });
      return t.id;
    },
    ownerOf: (trainerId) => db.trainers.find((t) => t.id === trainerId)!.ownerUserId,
    async sessionType(trainerId, o) {
      const st = { id: id('st'), trainerId, name: 'Session', minutes: o.minutes, capacity: o.capacity, credits: o.credits, active: true, sort: 0 };
      db.sessionTypes.push(st);
      return st.id;
    },
    async availability(trainerId, weekday, start, end, sessionTypeId) {
      db.availability.push({ id: id('av'), trainerId, weekday, start, end, location: null, sessionTypeId: sessionTypeId ?? null });
    },
    async timeOff(trainerId, startsAt, endsAt) {
      db.timeOff.push({ id: id('off'), trainerId, startsAt, endsAt, note: null });
    },
    async retireType(typeId) {
      db.sessionTypes.find((s) => s.id === typeId)!.active = false;
    },
    async user(email) {
      const u = { id: id('user'), email };
      db.users.push(u);
      return u.id;
    },
    join: (userId, trainerId, referralCode) =>
      as(userId, null, async () => {
        const c = await api.join(trainerId, { name: 'Test Client', referralCode, acceptTerms: true });
        return { id: c.id, referralCode: c.referralCode };
      }),
    addClient: (ownerId, trainerId, name, email) => as(ownerId, null, async () => ({ id: (await api.addClient(trainerId, { name, email })).id })),
    book: (userId, typeId, startsAt, at) => as(userId, at, async () => ({ id: (await api.book(typeId, startsAt)).id })),
    bookFor: (ownerId, clientId, typeId, startsAt) => as(ownerId, null, async () => ({ id: (await api.bookFor(clientId, typeId, startsAt)).id })),
    cancel: (userId, bookingId, at) => as(userId, at, async () => ({ status: (await api.cancel(bookingId)).status })),
    reschedule: (userId, bookingId, startsAt, at) => as(userId, at, async () => ({ id: (await api.reschedule(bookingId, startsAt)).id })),
    deleteAccount: (userId, trainerId) => as(userId, null, async () => (await api.deleteAccount(trainerId), null)),
    attend: (userId, bookingId, at) => as(userId, at, async () => ({ status: (await api.setAttendance(bookingId, 'attended')).status })),
    packPaid: (actorId, clientId, credits, opKey) =>
      as(actorId, null, async () => ({ rewarded: (await api.markPackPaid(clientId, { credits, method: 'cash', opId: opKey })).rewarded })),
    adjust: (actorId, clientId, delta, opKey) => as(actorId, null, async () => (await api.adjustCredits(clientId, delta, 'test', opKey), null)),
    reverse: (actorId, referralId) => as(actorId, null, async () => (await api.reverseReferral(referralId), null)),
    freeSlots: (userId, typeId, from, days, at) => as(userId, at, async () => (await api.freeSlots(typeId, from, days)).map((s) => s.startsAt)),
    fullSlots: (userId, typeId, from, days, at) => as(userId, at, async () => (await api.fullSlots(typeId, from, days)).map((s) => s.startsAt)),
    joinWaitlist: (userId, typeId, startsAt, at) => as(userId, at, async () => (await api.joinWaitlist(typeId, startsAt), null)),
    leaveWaitlist: (userId, entryId) => as(userId, null, async () => (await api.leaveWaitlist(entryId), null)),
    waitlist: (userId, trainerId, at) =>
      as(userId, at, async () => {
        const list = db.trainers.find((t) => t.id === trainerId)?.ownerUserId === userId ? (await api.trainerData(trainerId)).waitlist : await api.myWaitlist(trainerId);
        return list.map((e) => ({ id: e.id, clientId: e.clientId, startsAt: e.startsAt, open: e.open, position: e.position }));
      }),
    balance: async (clientId) => db.ledger.filter((l) => l.clientId === clientId).reduce((s, l) => s + l.delta, 0),
    ledgerCount: async (clientId, reason) => db.ledger.filter((l) => l.clientId === clientId && (!reason || l.reason === reason)).length,
    bookingCount: async (clientId, status, bookedBy) =>
      db.bookings.filter((b) => b.clientId === clientId && (!status || b.status === status) && (!bookedBy || b.bookedBy === bookedBy)).length,
    packCount: async (clientId) => db.packs.filter((p) => p.clientId === clientId).length,
    referral: async (referredClientId) => {
      const r = db.referrals.find((x) => x.referredClientId === referredClientId);
      return r ? { id: r.id, status: r.status } : null;
    },
  };
}

for (const s of scenarios) test(`demo: ${s.name}`, () => s.run(demoHarness()));

// The demo is what a trainer is shown: whatever day and hour it is opened, every look has a full session Sara waits for
// and a place that has just opened, and the trainer's panel lists both.
test('demo: the waiting list is filled on any day, for the client and for the trainer', async () => {
  for (let step = 0; step < 12; step++) {
    const now = Date.parse('2026-10-01T05:00:00.000Z') + step * 15 * 3_600_000 + step * 25 * 60_000; // about a week and a half, every hour of the day
    const api = createDemoApi({ storage: null, now: () => now, seed: buildSeed });
    for (const t of api.db().trainers) {
      const when = `${t.slug} at ${new Date(now).toISOString()}`;
      api.setActor(DEMO_USER);
      const mine = await api.myWaitlist(t.id);
      assert.deepEqual(mine.map((e) => [e.open, e.position]).sort(), [[false, 2], [true, 2]], when);
      for (const e of mine) assert.ok(Date.parse(e.startsAt) >= now + (t.minNoticeHours + 24) * 3_600_000, when);
      api.setActor(t.ownerUserId);
      const all = (await api.trainerData(t.id)).waitlist;
      assert.equal(all.length, 4, when);
      assert.equal(all.filter((e) => e.open).length, 2, when);
      assert.deepEqual(all.map((e) => e.position).sort(), [1, 1, 2, 2], when);
      // Sara can book the place that opened, and it leaves her list
      api.setActor(DEMO_USER);
      const open = mine.find((e) => e.open)!;
      await api.book(open.sessionTypeId, open.startsAt);
      assert.equal((await api.myWaitlist(t.id)).length, 1, when);
    }
  }
});

// The brand preview copies a trainer's calendar for a prospect: the waiting list has to come along.
test('demo: a copied trainer keeps the waiting list', async () => {
  const now = Date.parse('2026-10-01T09:00:00.000Z');
  const api = createDemoApi({ storage: null, now: () => now, seed: buildSeed });
  const marco = api.db().trainers[0];
  api.cloneTrainer(marco.id, { ...marco, id: 'copy', slug: 'copy', name: 'Copy', ownerUserId: 'owner-copy' });
  api.setActor(DEMO_USER);
  const original = await api.myWaitlist(marco.id);
  const copy = await api.myWaitlist('copy');
  assert.equal(copy.length, 2);
  assert.deepEqual(copy.map((e) => [e.startsAt, e.open, e.position]), original.map((e) => [e.startsAt, e.open, e.position]));
  assert.ok(copy.every((e) => e.trainerId === 'copy' && e.clientId.endsWith('~copy') && e.sessionTypeId.endsWith('~copy')));
  api.setActor('owner-copy');
  assert.equal((await api.trainerData('copy')).waitlist.length, 4);
});
