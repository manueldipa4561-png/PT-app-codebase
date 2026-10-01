import { test } from 'node:test';
import { AppError, type TrainerPublic } from '../src/domain.ts';
import { createDemoApi } from '../src/demo.ts';
import { emptyDB, type DemoTrainer } from '../src/seed.ts';
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
    attend: (userId, bookingId, at) => as(userId, at, async () => ({ status: (await api.setAttendance(bookingId, 'attended')).status })),
    packPaid: (actorId, clientId, credits, opKey) =>
      as(actorId, null, async () => ({ rewarded: (await api.markPackPaid(clientId, { credits, method: 'cash', opId: opKey })).rewarded })),
    adjust: (actorId, clientId, delta, opKey) => as(actorId, null, async () => (await api.adjustCredits(clientId, delta, 'test', opKey), null)),
    reverse: (actorId, referralId) => as(actorId, null, async () => (await api.reverseReferral(referralId), null)),
    freeSlots: (userId, typeId, from, days, at) => as(userId, at, async () => (await api.freeSlots(typeId, from, days)).map((s) => s.startsAt)),
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
