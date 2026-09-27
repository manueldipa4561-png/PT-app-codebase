// One list of business scenarios, run against BOTH implementations:
//   tests/demo.test.ts  -> src/demo.ts (the demo data source, TypeScript)
//   tests/sql.test.ts   -> supabase/migrations (production rules, Postgres)
// If the two ever disagree, one of these fails. Add a scenario here, never in only one place.
import assert from 'node:assert/strict';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

export interface TrainerOpts {
  cancelWindowHours?: number;
  bonusReferrer?: number;
  bonusReferred?: number;
}

export interface Harness {
  trainer(o?: TrainerOpts): Promise<string>;
  ownerOf(trainerId: string): string;
  sessionType(trainerId: string, o: { minutes: number; capacity: number; credits: number }): Promise<string>;
  availability(trainerId: string, weekday: number, start: string, end: string, sessionTypeId?: string): Promise<void>;
  timeOff(trainerId: string, startsAt: string, endsAt: string): Promise<void>;
  user(email: string): Promise<string>;
  join(userId: string, trainerId: string, referralCode?: string): Promise<Result<{ id: string; referralCode: string }>>;
  addClient(ownerId: string, trainerId: string, name: string, email: string): Promise<Result<{ id: string }>>;
  book(userId: string, typeId: string, startsAt: string, now: string): Promise<Result<{ id: string }>>;
  bookFor(ownerId: string, clientId: string, typeId: string, startsAt: string): Promise<Result<{ id: string }>>;
  cancel(userId: string, bookingId: string, now: string): Promise<Result<{ status: string }>>;
  attend(userId: string, bookingId: string, now: string): Promise<Result<{ status: string }>>;
  packPaid(actorId: string, clientId: string, credits: number, opKey: string): Promise<Result<{ rewarded: boolean }>>;
  adjust(actorId: string, clientId: string, delta: number, opKey: string): Promise<Result<null>>;
  reverse(actorId: string, referralId: string): Promise<Result<null>>;
  freeSlots(userId: string, typeId: string, from: string, days: number, now: string): Promise<Result<string[]>>;
  balance(clientId: string): Promise<number>;
  ledgerCount(clientId: string, reason?: string): Promise<number>;
  bookingCount(clientId: string, status?: string, bookedBy?: string): Promise<number>;
  packCount(clientId: string): Promise<number>;
  referral(referredClientId: string): Promise<{ id: string; status: string } | null>;
}

// Sunday noon UTC; the Monday window below is 07:00-09:00 in Rome (UTC+2 in October).
const NOW = '2026-10-04T12:00:00.000Z';
const MON_7 = '2026-10-05T05:00:00.000Z';
const MON_730 = '2026-10-05T05:30:00.000Z';
const MON_8 = '2026-10-05T06:00:00.000Z';

function must<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected success, got ${r.code}`);
  return r.value;
}
const code = (r: Result<unknown>) => (r.ok ? 'ok' : r.code);

async function setup(h: Harness, o: TrainerOpts = {}, type = { minutes: 60, capacity: 1, credits: 1 }) {
  const t = await h.trainer(o);
  const ty = await h.sessionType(t, type);
  await h.availability(t, 1, '07:00', '09:00');
  return { t, ty, owner: h.ownerOf(t) };
}

async function client(h: Harness, t: string, email: string, credits = 0, referralCode?: string) {
  const u = await h.user(email);
  const c = must(await h.join(u, t, referralCode));
  if (credits) must(await h.packPaid(h.ownerOf(t), c.id, credits, `pack-${email}`));
  return { u, c };
}

export const scenarios: Array<{ name: string; run(h: Harness): Promise<void> }> = [
  {
    name: 'a booking takes the session cost from the balance and frees nothing else',
    async run(h) {
      const { t, ty } = await setup(h);
      const { u, c } = await client(h, t, 'a@example.com', 10);
      must(await h.book(u, ty, MON_7, NOW));
      assert.equal(await h.balance(c.id), 9);
      assert.equal(await h.bookingCount(c.id, 'booked', 'client'), 1);
      assert.deepEqual(must(await h.freeSlots(u, ty, '2026-10-05', 1, NOW)), [MON_8]);
    },
  },
  {
    name: 'no sessions left: NO_CREDITS and nothing is written',
    async run(h) {
      const { t, ty } = await setup(h);
      const { u, c } = await client(h, t, 'empty@example.com');
      assert.equal(code(await h.book(u, ty, MON_7, NOW)), 'NO_CREDITS');
      assert.equal(await h.bookingCount(c.id), 0);
      assert.equal(await h.ledgerCount(c.id), 0);
    },
  },
  {
    name: 'the last place goes to one client only',
    async run(h) {
      const { t, ty } = await setup(h);
      const a = await client(h, t, 'first@example.com', 5);
      const b = await client(h, t, 'second@example.com', 5);
      must(await h.book(a.u, ty, MON_7, NOW));
      assert.equal(code(await h.book(b.u, ty, MON_7, NOW)), 'SLOT_TAKEN');
      assert.equal(code(await h.book(b.u, ty, MON_730, NOW)), 'SLOT_TAKEN');
      must(await h.book(b.u, ty, MON_8, NOW));
      assert.equal(await h.balance(b.c.id), 4);
    },
  },
  {
    name: 'group sessions fill up to capacity',
    async run(h) {
      const { t, ty } = await setup(h, {}, { minutes: 60, capacity: 2, credits: 1 });
      const a = await client(h, t, 'g1@example.com', 3);
      const b = await client(h, t, 'g2@example.com', 3);
      const c = await client(h, t, 'g3@example.com', 3);
      must(await h.book(a.u, ty, MON_7, NOW));
      must(await h.book(b.u, ty, MON_7, NOW));
      assert.equal(code(await h.book(c.u, ty, MON_7, NOW)), 'SLOT_TAKEN');
    },
  },
  {
    name: 'retrying the same booking returns it instead of booking twice',
    async run(h) {
      const { t, ty } = await setup(h);
      const { u, c } = await client(h, t, 'retry@example.com', 10);
      const first = must(await h.book(u, ty, MON_7, NOW));
      const again = must(await h.book(u, ty, MON_7, NOW));
      assert.equal(again.id, first.id);
      assert.equal(await h.bookingCount(c.id), 1);
      assert.equal(await h.balance(c.id), 9);
    },
  },
  {
    name: 'time rules name the reason',
    async run(h) {
      const { t, ty } = await setup(h);
      const { u } = await client(h, t, 'rules@example.com', 10);
      assert.equal(code(await h.book(u, ty, MON_7, '2026-10-05T04:00:00.000Z')), 'TOO_SOON');
      assert.equal(code(await h.book(u, ty, MON_7, '2026-09-01T00:00:00.000Z')), 'TOO_FAR');
      assert.equal(code(await h.book(u, ty, '2026-10-05T05:15:00.000Z', NOW)), 'OUTSIDE_HOURS');
      await h.timeOff(t, '2026-10-05T05:00:00.000Z', '2026-10-05T06:00:00.000Z');
      assert.equal(code(await h.book(u, ty, MON_7, NOW)), 'OUTSIDE_HOURS');
      assert.equal(code(await h.book(u, ty, MON_730, NOW)), 'OUTSIDE_HOURS');
      must(await h.book(u, ty, MON_8, NOW));
    },
  },
  {
    name: 'cancel refunds outside the window and charges inside it',
    async run(h) {
      const { t, ty } = await setup(h);
      const { u, c } = await client(h, t, 'cancel@example.com', 10);
      const early = must(await h.book(u, ty, MON_7, NOW));
      assert.equal(must(await h.cancel(u, early.id, '2026-10-04T04:00:00.000Z')).status, 'cancelled');
      assert.equal(await h.balance(c.id), 10);
      const late = must(await h.book(u, ty, MON_8, NOW));
      assert.equal(must(await h.cancel(u, late.id, '2026-10-04T07:00:00.000Z')).status, 'late_cancel');
      assert.equal(await h.balance(c.id), 9);
      assert.equal(await h.ledgerCount(c.id, 'refund'), 1);
      assert.equal(code(await h.cancel(u, late.id, NOW)), 'NOT_FOUND');
    },
  },
  {
    name: 'a referral rewards both people once, on the first paid pack',
    async run(h) {
      const { t, owner } = await setup(h);
      const a = await client(h, t, 'ref-a@example.com');
      const b = await client(h, t, 'ref-b@example.com', 0, a.c.referralCode);
      assert.equal((await h.referral(b.c.id))?.status, 'pending');
      assert.equal(must(await h.packPaid(owner, b.c.id, 10, 'first-pack')).rewarded, true);
      assert.equal(await h.balance(b.c.id), 11);
      assert.equal(await h.balance(a.c.id), 1);
      assert.equal(await h.ledgerCount(a.c.id, 'referral'), 1);
      assert.equal(await h.ledgerCount(b.c.id, 'referral'), 1);
      assert.equal(must(await h.packPaid(owner, b.c.id, 5, 'second-pack')).rewarded, false);
      assert.equal(await h.ledgerCount(b.c.id, 'referral'), 1);
      assert.equal(await h.balance(b.c.id), 16);
      assert.equal((await h.referral(b.c.id))?.status, 'rewarded');
    },
  },
  {
    name: 'reversing a referral takes both bonuses back, once',
    async run(h) {
      const { t, owner } = await setup(h);
      const a = await client(h, t, 'rev-a@example.com');
      const b = await client(h, t, 'rev-b@example.com', 0, a.c.referralCode);
      must(await h.packPaid(owner, b.c.id, 10, 'rev-pack'));
      const ref = (await h.referral(b.c.id))!;
      must(await h.reverse(owner, ref.id));
      assert.equal(await h.balance(a.c.id), 0);
      assert.equal(await h.balance(b.c.id), 10);
      assert.equal((await h.referral(b.c.id))?.status, 'reversed');
      assert.equal(code(await h.reverse(owner, ref.id)), 'NOT_FOUND');
    },
  },
  {
    name: 'marking a pack paid twice with the same operation adds credits once',
    async run(h) {
      const { t, owner } = await setup(h);
      const { c } = await client(h, t, 'twice@example.com');
      must(await h.packPaid(owner, c.id, 10, 'same-tap'));
      must(await h.packPaid(owner, c.id, 10, 'same-tap'));
      assert.equal(await h.packCount(c.id), 1);
      assert.equal(await h.balance(c.id), 10);
    },
  },
  {
    name: 'manual adjustments are validated and idempotent',
    async run(h) {
      const { t, owner } = await setup(h);
      const { u, c } = await client(h, t, 'adjust@example.com');
      must(await h.adjust(owner, c.id, 3, 'opening-balance'));
      must(await h.adjust(owner, c.id, 3, 'opening-balance'));
      assert.equal(await h.balance(c.id), 3);
      assert.equal(code(await h.adjust(u, c.id, 5, 'self-service')), 'NOT_ALLOWED');
      assert.equal(code(await h.adjust(owner, c.id, 0, 'zero')), 'INVALID_INPUT');
    },
  },
  {
    name: 'clients cannot act as the trainer or book another trainer',
    async run(h) {
      const one = await setup(h);
      const two = await setup(h);
      const { u, c } = await client(h, one.t, 'hostile@example.com', 10);
      assert.equal(code(await h.book(u, two.ty, MON_7, NOW)), 'NOT_ALLOWED');
      assert.equal(code(await h.packPaid(u, c.id, 10, 'self-pack')), 'NOT_ALLOWED');
      assert.equal(code(await h.packPaid(two.owner, c.id, 10, 'other-trainer')), 'NOT_ALLOWED');
      assert.equal(code(await h.freeSlots(u, two.ty, '2026-10-05', 1, NOW)), 'NOT_ALLOWED');
      assert.equal(await h.balance(c.id), 10);
    },
  },
  {
    name: 'unknown invite codes are ignored',
    async run(h) {
      const { t } = await setup(h);
      const { c } = await client(h, t, 'nocode@example.com', 0, 'ZZZZZZ');
      assert.equal(await h.referral(c.id), null);
    },
  },
  {
    name: 'the trainer can book for a client with no sessions left, never over a full slot',
    async run(h) {
      const { t, ty, owner } = await setup(h);
      const a = await client(h, t, 'tb-a@example.com');
      must(await h.bookFor(owner, a.c.id, ty, MON_7));
      assert.equal(await h.balance(a.c.id), -1);
      assert.equal(await h.bookingCount(a.c.id, 'booked', 'trainer'), 1);
      const b = await client(h, t, 'tb-b@example.com', 5);
      assert.equal(code(await h.bookFor(owner, b.c.id, ty, MON_7)), 'SLOT_TAKEN');
      assert.equal(code(await h.book(b.u, ty, MON_730, NOW)), 'SLOT_TAKEN');
      assert.equal(code(await h.bookFor(b.u, b.c.id, ty, MON_8)), 'NOT_ALLOWED');
    },
  },
  {
    name: 'a client added by the trainer is claimed at sign-up by email',
    async run(h) {
      const { t, owner } = await setup(h);
      const added = must(await h.addClient(owner, t, 'Giorgio Fontana', 'giorgio@example.com'));
      must(await h.packPaid(owner, added.id, 10, 'claim-pack'));
      const u = await h.user('Giorgio@Example.com');
      const joined = must(await h.join(u, t));
      assert.equal(joined.id, added.id);
      assert.equal(await h.balance(joined.id), 10);
    },
  },
  {
    name: 'attendance is marked by the trainer, only once the session started',
    async run(h) {
      const { t, ty, owner } = await setup(h);
      const { u, c } = await client(h, t, 'attend@example.com', 3);
      const b = must(await h.book(u, ty, MON_7, NOW));
      assert.equal(code(await h.attend(owner, b.id, NOW)), 'NOT_ALLOWED');
      assert.equal(code(await h.attend(u, b.id, '2026-10-05T06:30:00.000Z')), 'NOT_ALLOWED');
      assert.equal(must(await h.attend(owner, b.id, '2026-10-05T06:30:00.000Z')).status, 'attended');
      assert.equal(await h.balance(c.id), 2);
    },
  },
  {
    name: 'free slots agree across a daylight-saving weekend',
    async run(h) {
      const t = await h.trainer();
      const ty = await h.sessionType(t, { minutes: 60, capacity: 1, credits: 1 });
      await h.availability(t, 6, '09:00', '10:00');
      await h.availability(t, 7, '09:00', '10:00');
      const { u } = await client(h, t, 'dst@example.com');
      const slots = must(await h.freeSlots(u, ty, '2026-03-28', 2, '2026-03-20T00:00:00.000Z'));
      assert.deepEqual(slots, ['2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z']);
    },
  },
];
