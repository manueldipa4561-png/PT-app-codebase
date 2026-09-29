// The demo data source: the whole backend, in the browser, with no server and no cost.
// It mirrors the SQL functions in supabase/migrations one to one (same checks, same
// order, same error codes); tests/scenarios.ts runs against both to keep them equal.
import {
  AppError,
  PAY_METHODS,
  REFERRAL_CODE,
  balanceOf,
  cancelOutcome,
  candidateSlots,
  firstName,
  freeSlots,
  isEmail,
  isPhone,
  localParts,
  newReferralCode,
  placesLeftAt,
  slotStatus,
  type Booking,
  type Client,
  type LedgerEntry,
  type SessionType,
  type TimeOff,
} from './domain.ts';
import { buildSeed, DEMO_USER, DEMO_VERSION, type DemoDB, type DemoTrainer } from './seed.ts';
import type { Api, Me, ReferralView, TrainerData } from './api.ts';

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** localStorage when it works; null in private mode or when blocked (the demo then runs in memory). */
export function browserStorage(): KV | null {
  try {
    const s = window.localStorage;
    s.setItem('__pt_probe__', '1');
    s.removeItem('__pt_probe__');
    let warned = false;
    const warn = (e: unknown) => {
      if (!warned) console.warn('demo: storage unavailable, changes stay in memory until reload', e);
      warned = true;
    };
    return {
      get: (k) => {
        try {
          return s.getItem(k);
        } catch (e) {
          warn(e);
          return null;
        }
      },
      set: (k, v) => {
        try {
          s.setItem(k, v);
        } catch (e) {
          warn(e);
        }
      },
      remove: (k) => {
        try {
          s.removeItem(k);
        } catch (e) {
          warn(e);
        }
      },
    };
  } catch {
    return null;
  }
}

export interface DemoOptions {
  storage?: KV | null;
  now?: () => number;
  seed?: (now: number) => DemoDB;
  latencyMs?: number;
}

export interface DemoApi extends Api {
  readonly mode: 'demo';
  db(): DemoDB;
  actor(): string | null;
  setActor(userId: string | null): void;
  reset(): void;
  upsertTrainer(t: DemoTrainer): void;
  /** Demo brand preview: a new trainer with a copy of another trainer's calendar, clients and shop. */
  cloneTrainer(fromId: string, t: DemoTrainer): void;
}

const STORAGE_KEY = 'pt-demo';
const RESEED_AFTER = 12 * 3_600_000;
const MINUTE = 60_000;
const OCCUPYING_OR_DONE = new Set(['booked', 'attended', 'no_show']);

export function createDemoApi(opts: DemoOptions = {}): DemoApi {
  const storage = opts.storage ?? null;
  const clock = opts.now ?? (() => Date.now());
  const seed = opts.seed ?? buildSeed;
  let actor: string | null = DEMO_USER;
  let db = load();

  function load(): DemoDB {
    const raw = storage?.get(STORAGE_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as DemoDB & { actor?: string | null };
        if (saved.version === DEMO_VERSION && clock() - saved.seededAt < RESEED_AFTER) {
          actor = saved.actor === undefined ? DEMO_USER : saved.actor;
          return saved;
        }
      } catch (e) {
        console.warn('demo: saved data unreadable, starting fresh', e);
      }
    }
    return seed(clock());
  }
  const save = () => storage?.set(STORAGE_KEY, JSON.stringify({ ...db, actor }));

  const iso = (ms: number) => new Date(ms).toISOString();
  const nowIso = () => iso(clock());
  const uid = () => crypto.randomUUID();
  const wait = () => (opts.latencyMs ? new Promise<void>((r) => setTimeout(r, opts.latencyMs)) : Promise.resolve());

  const trainer = (id: string): DemoTrainer => {
    const t = db.trainers.find((x) => x.id === id);
    if (!t) throw new AppError('NOT_FOUND', 'trainer');
    return t;
  };
  const isOwner = (t: DemoTrainer) => actor !== null && t.ownerUserId === actor;
  const myClient = (trainerId: string): Client | null =>
    (actor && db.clients.find((c) => c.trainerId === trainerId && c.userId === actor && !c.deletedAt)) || null;
  const requireOwner = (trainerId: string) => {
    const t = trainer(trainerId);
    if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
    return t;
  };
  const liveClient = (clientId: string) => {
    const c = db.clients.find((x) => x.id === clientId && !x.deletedAt);
    if (!c) throw new AppError('NOT_FOUND', 'client');
    return c;
  };
  const addLedger = (e: Omit<LedgerEntry, 'id' | 'createdAt'>) => db.ledger.push({ id: uid(), createdAt: nowIso(), ...e });
  const bookingsOf = (trainerId: string) => db.bookings.filter((b) => b.trainerId === trainerId);
  const slotInput = (t: DemoTrainer, st: SessionType) => ({
    rules: t,
    type: st,
    availability: db.availability.filter((a) => a.trainerId === t.id),
    timeOff: db.timeOff.filter((o) => o.trainerId === t.id),
    bookings: bookingsOf(t.id),
  });
  const activeType = (id: string) => {
    const st = db.sessionTypes.find((s) => s.id === id && s.active);
    if (!st) throw new AppError('NOT_FOUND', 'session type');
    return st;
  };
  const parseStart = (startsAt: string) => {
    const start = Date.parse(startsAt);
    if (Number.isNaN(start)) throw new AppError('INVALID_INPUT', 'startsAt');
    return start;
  };
  const retryOf = (clientId: string, start: number) =>
    db.bookings.find((b) => b.clientId === clientId && b.status === 'booked' && Date.parse(b.startsAt) === start);
  const locationAt = (t: DemoTrainer, st: SessionType, start: number) =>
    candidateSlots({ ...slotInput(t, st), from: localParts(start, t.timezone).date, days: 1 }).find((c) => Date.parse(c.startsAt) === start)
      ?.location ?? null;
  const createBooking = (t: DemoTrainer, c: Client, st: SessionType, start: number, bookedBy: 'client' | 'trainer'): Booking => {
    const b: Booking = {
      id: uid(),
      trainerId: t.id,
      clientId: c.id,
      sessionTypeId: st.id,
      startsAt: iso(start),
      endsAt: iso(start + st.minutes * MINUTE),
      location: locationAt(t, st, start),
      status: 'booked',
      bookedBy,
      createdAt: nowIso(),
      cancelledAt: null,
    };
    db.bookings.push(b);
    if (st.credits > 0) addLedger({ trainerId: t.id, clientId: c.id, delta: -st.credits, reason: 'booking', bookingId: b.id });
    return b;
  };

  const api: DemoApi = {
    mode: 'demo',
    db: () => db,
    actor: () => actor,
    setActor(userId) {
      actor = userId;
      save();
    },
    reset() {
      db = seed(clock());
      actor = DEMO_USER;
      save();
    },
    upsertTrainer(t) {
      const i = db.trainers.findIndex((x) => x.id === t.id);
      if (i >= 0) db.trainers[i] = t;
      else db.trainers.push(t);
      save();
    },
    cloneTrainer(fromId, t) {
      if (db.trainers.some((x) => x.id === t.id)) return api.upsertTrainer(t);
      const id = (old: string | null | undefined) => (old ? `${old}~${t.id}` : old ?? null);
      const own = <T extends { trainerId: string }>(xs: T[]) => xs.filter((x) => x.trainerId === fromId);
      db.trainers.push(t);
      if (!db.users.some((u) => u.id === t.ownerUserId)) db.users.push({ id: t.ownerUserId, email: `${t.slug}@example.com` });
      db.sessionTypes.push(...own(db.sessionTypes).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id })));
      db.availability.push(...own(db.availability).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id, sessionTypeId: id(x.sessionTypeId) })));
      db.timeOff.push(...own(db.timeOff).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id })));
      db.clients.push(...own(db.clients).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id })));
      db.bookings.push(...own(db.bookings).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id, clientId: id(x.clientId)!, sessionTypeId: id(x.sessionTypeId)! })));
      db.packs.push(...own(db.packs).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id, clientId: id(x.clientId)!, opId: id(x.opId)! })));
      db.referrals.push(
        ...own(db.referrals).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id, referrerClientId: id(x.referrerClientId)!, referredClientId: id(x.referredClientId)! })),
      );
      db.ledger.push(
        ...own(db.ledger).map((x) => ({
          ...x,
          id: id(x.id)!,
          trainerId: t.id,
          clientId: id(x.clientId)!,
          bookingId: id(x.bookingId),
          packId: id(x.packId),
          referralId: id(x.referralId),
          opId: id(x.opId),
        })),
      );
      db.products.push(...own(db.products).map((x) => ({ ...x, id: id(x.id)!, trainerId: t.id })));
      db.visits.push(...own(db.visits).map((x) => ({ ...x, trainerId: t.id })));
      save();
    },

    async getTrainer(key) {
      await wait();
      const k = key.trim().toLowerCase();
      const t = db.trainers.find((x) => x.slug === k || x.domain === k);
      if (!t) throw new AppError('TENANT_NOT_FOUND', key);
      return t;
    },
    async sessionTypes(trainerId) {
      await wait();
      return db.sessionTypes.filter((s) => s.trainerId === trainerId && s.active).sort((a, b) => a.sort - b.sort);
    },
    async products(trainerId) {
      await wait();
      return db.products.filter((p) => p.trainerId === trainerId && p.active).sort((a, b) => a.sort - b.sort);
    },
    async logVisit(trainerId, installed) {
      const t = db.trainers.find((x) => x.id === trainerId);
      if (!t) return; // like the SQL: an unknown trainer counts nothing
      const day = localParts(clock(), t.timezone).date;
      let v = db.visits.find((x) => x.trainerId === t.id && x.day === day);
      if (!v) db.visits.push((v = { trainerId: t.id, day, opens: 0, installed: 0 }));
      v.opens += 1;
      if (installed) v.installed += 1;
      save();
    },

    async sendCode(email) {
      await wait();
      if (!isEmail(email.trim())) throw new AppError('INVALID_INPUT', 'email');
    },
    async verifyCode(email, code) {
      await wait();
      if (!/^\d{6}$/.test(code.trim())) throw new AppError('INVALID_CODE');
      const e = email.trim().toLowerCase();
      let u = db.users.find((x) => x.email.toLowerCase() === e);
      if (!u) {
        u = { id: uid(), email: e };
        db.users.push(u);
      }
      actor = u.id;
      save();
    },
    async signOut() {
      actor = null;
      save();
    },
    async me(trainerId): Promise<Me> {
      await wait();
      const t = trainer(trainerId);
      const u = db.users.find((x) => x.id === actor);
      return { userId: actor, email: u?.email ?? null, client: myClient(t.id), isOwner: isOwner(t) };
    },
    async join(trainerId, input) {
      await wait();
      if (!actor) throw new AppError('NOT_ALLOWED');
      const t = trainer(trainerId);
      const existing = myClient(t.id);
      if (existing) return existing;
      if (!input.acceptTerms) throw new AppError('INVALID_INPUT', 'terms');
      const name = input.name.trim();
      if (name.length < 1 || name.length > 80) throw new AppError('INVALID_INPUT', 'name');
      const phone = input.phone?.trim() || null;
      if (phone && !isPhone(phone)) throw new AppError('INVALID_INPUT', 'phone');
      const email = db.users.find((x) => x.id === actor)?.email ?? null;

      // A client the trainer already added with this email becomes this login.
      const claim = email
        ? db.clients.find((c) => c.trainerId === t.id && !c.userId && !c.deletedAt && c.email?.toLowerCase() === email.toLowerCase())
        : undefined;
      if (claim) {
        claim.userId = actor;
        claim.termsAcceptedAt = nowIso();
        claim.termsVersion = t.termsVersion;
        save();
        return claim;
      }

      const c: Client = {
        id: uid(),
        trainerId: t.id,
        userId: actor,
        name,
        email,
        phone,
        referralCode: newReferralCode((code) => db.clients.some((x) => x.trainerId === t.id && x.referralCode === code)),
        termsAcceptedAt: nowIso(),
        termsVersion: t.termsVersion,
        createdAt: nowIso(),
        deletedAt: null,
      };
      db.clients.push(c);
      const code = input.referralCode?.trim().toUpperCase();
      if (code && REFERRAL_CODE.test(code)) {
        const referrer = db.clients.find((x) => x.trainerId === t.id && x.referralCode === code && !x.deletedAt && x.id !== c.id);
        if (referrer && referrer.userId !== actor) {
          db.referrals.push({
            id: uid(),
            trainerId: t.id,
            referrerClientId: referrer.id,
            referredClientId: c.id,
            status: 'pending',
            createdAt: nowIso(),
            rewardedAt: null,
            reversedAt: null,
          });
        }
      }
      save();
      return c;
    },

    async myLedger(trainerId) {
      await wait();
      const c = myClient(trainerId);
      return c ? db.ledger.filter((l) => l.clientId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
    },
    async myBookings(trainerId) {
      await wait();
      const c = myClient(trainerId);
      return c ? db.bookings.filter((b) => b.clientId === c.id).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) : [];
    },
    async myReferrals(trainerId): Promise<ReferralView[]> {
      await wait();
      const c = myClient(trainerId);
      if (!c) return [];
      return db.referrals
        .filter((r) => r.referrerClientId === c.id)
        .map((r) => ({
          id: r.id,
          name: firstName(db.clients.find((x) => x.id === r.referredClientId)?.name ?? ''),
          status: r.status,
          createdAt: r.createdAt,
          rewardedAt: r.rewardedAt,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async freeSlots(sessionTypeId, from, days) {
      await wait();
      const st = activeType(sessionTypeId);
      const t = trainer(st.trainerId);
      if (!myClient(t.id) && !isOwner(t)) throw new AppError('NOT_ALLOWED');
      if (!Number.isInteger(days) || days < 1 || days > 31) throw new AppError('INVALID_INPUT', 'days');
      return freeSlots({ ...slotInput(t, st), from, days, now: clock() });
    },
    async book(sessionTypeId, startsAt) {
      await wait();
      const st = activeType(sessionTypeId);
      const t = trainer(st.trainerId);
      const c = myClient(t.id);
      if (!c) throw new AppError('NOT_ALLOWED');
      const start = parseStart(startsAt);
      const again = retryOf(c.id, start);
      if (again) return { ...again };
      const status = slotStatus({ ...slotInput(t, st), now: clock() }, start);
      if (status !== 'ok') throw new AppError(status);
      if (balanceOf(db.ledger, c.id) < st.credits) throw new AppError('NO_CREDITS');
      const b = createBooking(t, c, st, start, 'client');
      save();
      return { ...b };
    },
    async cancel(bookingId) {
      await wait();
      const b = db.bookings.find((x) => x.id === bookingId);
      if (!b) throw new AppError('NOT_FOUND', 'booking');
      const t = trainer(b.trainerId);
      const owner = isOwner(t);
      if (!owner && myClient(t.id)?.id !== b.clientId) throw new AppError('NOT_ALLOWED');
      const out = cancelOutcome(b, owner, clock(), t.cancelWindowHours);
      if (typeof out === 'string') throw new AppError(out);
      b.status = out.status;
      b.cancelledAt = nowIso();
      if (out.refund) {
        const charged = -db.ledger.filter((l) => l.bookingId === b.id && l.reason === 'booking').reduce((s, l) => s + l.delta, 0);
        if (charged > 0) addLedger({ trainerId: t.id, clientId: b.clientId, delta: charged, reason: 'refund', bookingId: b.id });
      }
      save();
      return { ...b };
    },
    async deleteAccount(trainerId) {
      await wait();
      const c = myClient(trainerId);
      if (!c) throw new AppError('NOT_FOUND', 'client');
      for (const b of db.bookings) {
        if (b.clientId === c.id && b.status === 'booked' && Date.parse(b.startsAt) > clock()) {
          b.status = 'cancelled';
          b.cancelledAt = nowIso();
        }
      }
      const user = actor;
      Object.assign(c, { name: 'Deleted client', email: null, phone: null, userId: null, deletedAt: nowIso() });
      // The login is shared by every trainer app: remove it only when nothing uses it.
      if (!db.clients.some((x) => x.userId === user)) db.users = db.users.filter((u) => u.id !== user);
      actor = null;
      save();
    },

    async trainerData(trainerId): Promise<TrainerData> {
      await wait();
      const t = requireOwner(trainerId);
      const of = <T extends { trainerId: string }>(xs: T[]) => xs.filter((x) => x.trainerId === t.id);
      return {
        clients: of(db.clients),
        bookings: of(db.bookings),
        ledger: of(db.ledger),
        referrals: of(db.referrals),
        packs: of(db.packs),
        timeOff: of(db.timeOff),
        visits: of(db.visits),
      };
    },
    async addClient(trainerId, input) {
      await wait();
      const t = requireOwner(trainerId);
      const name = input.name.trim();
      const email = input.email?.trim() || null;
      const phone = input.phone?.trim() || null;
      if (name.length < 1 || name.length > 80) throw new AppError('INVALID_INPUT', 'name');
      if (email && !isEmail(email)) throw new AppError('INVALID_INPUT', 'email');
      if (phone && !isPhone(phone)) throw new AppError('INVALID_INPUT', 'phone');
      if (email && db.clients.some((c) => c.trainerId === t.id && !c.deletedAt && c.email?.toLowerCase() === email.toLowerCase())) {
        throw new AppError('INVALID_INPUT', 'email in use');
      }
      const c: Client = {
        id: uid(),
        trainerId: t.id,
        userId: null,
        name,
        email,
        phone,
        referralCode: newReferralCode((code) => db.clients.some((x) => x.trainerId === t.id && x.referralCode === code)),
        termsAcceptedAt: null,
        termsVersion: null,
        createdAt: nowIso(),
        deletedAt: null,
      };
      db.clients.push(c);
      save();
      return c;
    },
    async bookFor(clientId, sessionTypeId, startsAt) {
      await wait();
      const c = liveClient(clientId);
      const t = trainer(c.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      const st = db.sessionTypes.find((s) => s.id === sessionTypeId && s.trainerId === t.id && s.active);
      if (!st) throw new AppError('NOT_FOUND', 'session type');
      const start = parseStart(startsAt);
      const again = retryOf(c.id, start);
      if (again) return { ...again };
      // The trainer may book outside published hours, never over another session.
      if (placesLeftAt(st, bookingsOf(t.id), start, start + st.minutes * MINUTE) <= 0) throw new AppError('SLOT_TAKEN');
      const b = createBooking(t, c, st, start, 'trainer');
      save();
      return { ...b };
    },
    async markPackPaid(clientId, input) {
      await wait();
      const c = liveClient(clientId);
      const t = trainer(c.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      const price = input.priceCents ?? null;
      const valid =
        Number.isInteger(input.credits) &&
        input.credits >= 1 &&
        input.credits <= 200 &&
        !!input.opId &&
        PAY_METHODS.includes(input.method) &&
        (price === null || (Number.isInteger(price) && price >= 0 && price <= 1_000_000));
      if (!valid) throw new AppError('INVALID_INPUT', 'pack');
      const existing = db.packs.find((p) => p.opId === input.opId);
      if (existing) return { packId: existing.id, rewarded: false };

      const pack = {
        id: uid(),
        trainerId: t.id,
        clientId: c.id,
        credits: input.credits,
        priceCents: price,
        method: input.method,
        paidAt: nowIso(),
        note: input.note?.trim() || null,
        opId: input.opId,
        voidedAt: null,
      };
      db.packs.push(pack);
      addLedger({ trainerId: t.id, clientId: c.id, delta: pack.credits, reason: 'pack', packId: pack.id });

      // Two-sided referral: both people are rewarded once, when the new client's first pack is paid.
      const r = db.referrals.find((x) => x.referredClientId === c.id && x.status === 'pending');
      if (r) {
        if (t.bonusReferred > 0) addLedger({ trainerId: t.id, clientId: c.id, delta: t.bonusReferred, reason: 'referral', referralId: r.id });
        if (t.bonusReferrer > 0) addLedger({ trainerId: t.id, clientId: r.referrerClientId, delta: t.bonusReferrer, reason: 'referral', referralId: r.id });
        r.status = 'rewarded';
        r.rewardedAt = nowIso();
      }
      save();
      return { packId: pack.id, rewarded: !!r };
    },
    async voidPack(packId) {
      await wait();
      const p = db.packs.find((x) => x.id === packId && !x.voidedAt);
      if (!p) throw new AppError('NOT_FOUND', 'pack');
      const t = trainer(p.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      p.voidedAt = nowIso();
      addLedger({ trainerId: t.id, clientId: p.clientId, delta: -p.credits, reason: 'pack_void', packId: p.id });
      save();
    },
    async adjustCredits(clientId, delta, note, opId) {
      await wait();
      const c = liveClient(clientId);
      const t = trainer(c.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      if (!Number.isInteger(delta) || delta === 0 || delta < -200 || delta > 200 || !opId) throw new AppError('INVALID_INPUT', 'delta');
      if (db.ledger.some((l) => l.opId === opId)) return;
      addLedger({ trainerId: t.id, clientId: c.id, delta, reason: 'manual', note: note.trim().slice(0, 140) || null, opId });
      save();
    },
    async setAttendance(bookingId, status) {
      await wait();
      const b = db.bookings.find((x) => x.id === bookingId);
      if (!b) throw new AppError('NOT_FOUND', 'booking');
      const t = trainer(b.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      if (status !== 'attended' && status !== 'no_show') throw new AppError('INVALID_INPUT', 'status');
      if (!OCCUPYING_OR_DONE.has(b.status)) throw new AppError('NOT_FOUND', 'booking');
      if (Date.parse(b.startsAt) > clock()) throw new AppError('NOT_ALLOWED');
      b.status = status;
      save();
      return { ...b };
    },
    async reverseReferral(referralId) {
      await wait();
      const r = db.referrals.find((x) => x.id === referralId && x.status !== 'reversed');
      if (!r) throw new AppError('NOT_FOUND', 'referral');
      const t = trainer(r.trainerId);
      if (!isOwner(t)) throw new AppError('NOT_ALLOWED');
      if (r.status === 'rewarded') {
        for (const l of db.ledger.filter((x) => x.referralId === r.id && x.reason === 'referral')) {
          addLedger({ trainerId: t.id, clientId: l.clientId, delta: -l.delta, reason: 'referral_reversal', referralId: r.id });
        }
      }
      r.status = 'reversed';
      r.reversedAt = nowIso();
      save();
    },
    async addTimeOff(trainerId, startsAt, endsAt, note) {
      await wait();
      const t = requireOwner(trainerId);
      const s = parseStart(startsAt);
      const e = parseStart(endsAt);
      if (e <= s) throw new AppError('INVALID_INPUT', 'range');
      const off: TimeOff = { id: uid(), trainerId: t.id, startsAt: iso(s), endsAt: iso(e), note: note?.trim() || null };
      db.timeOff.push(off);
      save();
      return off;
    },
    async removeTimeOff(id) {
      await wait();
      const off = db.timeOff.find((o) => o.id === id);
      if (!off) throw new AppError('NOT_FOUND', 'time off');
      requireOwner(off.trainerId);
      db.timeOff = db.timeOff.filter((o) => o.id !== id);
      save();
    },
  };
  return api;
}
