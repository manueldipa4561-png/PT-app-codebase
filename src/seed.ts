// Demo data: three fictional trainers, one per look, with about a month of realistic
// bookings, packs and referrals generated relative to "now", so the demo never looks stale.
// Photos: Unsplash (Unsplash License). Names and businesses are invented.
import {
  addDays,
  candidateSlots,
  isoWeekday,
  localParts,
  newReferralCode,
  zonedToUtc,
  type Availability,
  type Booking,
  type BookingStatus,
  type Candidate,
  type Client,
  type LedgerEntry,
  type PackPurchase,
  type PayMethod,
  type Product,
  type Referral,
  type SessionType,
  type TimeOff,
  type TrainerPublic,
} from './domain.ts';

export interface DemoTrainer extends TrainerPublic {
  ownerUserId: string;
  domain: string | null;
}

export interface DemoUser {
  id: string;
  email: string;
}

export interface DemoDB {
  version: number;
  seededAt: number;
  trainers: DemoTrainer[];
  users: DemoUser[];
  sessionTypes: SessionType[];
  availability: Availability[];
  timeOff: TimeOff[];
  clients: Client[];
  bookings: Booking[];
  packs: PackPurchase[];
  ledger: LedgerEntry[];
  referrals: Referral[];
  products: Product[];
}

export const DEMO_VERSION = 5;
export const DEMO_USER = 'demo-user';
export const DEMO_EMAIL = 'sara.conti@example.com';
export const DEMO_PAYMENT_URL = 'https://buy.stripe.com/demo';

const unsplash = (id: string) => `https://images.unsplash.com/${id}?w=1400&q=70&auto=format&fit=crop`;
export const PHOTOS = {
  strength: unsplash('photo-1581009146145-b5ef050c2e1e'),
  deadlift: unsplash('photo-1517836357463-d25dfeac3438'),
  matMono: unsplash('photo-1599901860904-17e6ed7083a0'),
  matGroup: unsplash('photo-1518611012118-696072aa579a'),
  brightGym: unsplash('photo-1540497077202-7c8a3999166f'),
  floorCore: unsplash('photo-1571019613454-1cb2f99b2d8b'),
  rack: unsplash('photo-1534438327276-14e5300c3a48'),
  dumbbells: unsplash('photo-1576678927484-cc907957088c'),
  darkGym: unsplash('photo-1593079831268-3381b0db4a77'),
  barbellMono: unsplash('photo-1574680096145-d05b474e2155'),
};
export const COVER_CHOICES: string[] = Object.values(PHOTOS);

const COMMON = {
  timezone: 'Europe/Rome',
  locale: 'it' as const,
  currency: 'EUR',
  slotStepMinutes: 30,
  minNoticeHours: 2,
  bookingHorizonDays: 28,
  cancelWindowHours: 24,
  bonusReferrer: 1,
  bonusReferred: 1,
  termsVersion: 1,
  whatsapp: null,
  instagram: null,
  domain: null,
};

export const DEMO_TRAINERS: DemoTrainer[] = [
  {
    ...COMMON,
    id: 'tr-marco',
    slug: 'marco-bellini',
    ownerUserId: 'owner-marco',
    name: 'Marco Bellini',
    tagline: 'Forza, tecnica, costanza. Personal training a Milano.',
    template: 'energy',
    plan: 'store',
    theme: { brand: '#CBF24A', accent: '#FF6A2B', mode: 'dark', cover: PHOTOS.strength },
  },
  {
    ...COMMON,
    id: 'tr-giulia',
    slug: 'giulia-ferri',
    ownerUserId: 'owner-giulia',
    name: 'Giulia Ferri',
    tagline: 'Pilates reformer e postura a Roma. Lezioni private e piccoli gruppi.',
    template: 'luxe',
    plan: 'pro',
    theme: { brand: '#0F4C4A', accent: '#D8C3A0', mode: 'auto', cover: PHOTOS.matMono },
  },
  {
    ...COMMON,
    id: 'tr-luca',
    slug: 'luca-moretti',
    ownerUserId: 'owner-luca',
    name: 'Luca Moretti',
    tagline: 'Functional training a Torino. Programmi su misura, progressi che si vedono.',
    template: 'studio',
    plan: 'web',
    theme: { brand: '#1F4BFF', accent: '#7AA2FF', mode: 'auto', cover: PHOTOS.brightGym },
  },
];

const type = (id: string, trainerId: string, name: string, description: string, minutes: number, capacity: number, credits: number, sort: number): SessionType => ({
  id, trainerId, name, description, minutes, capacity, credits, active: true, sort,
});

const SESSION_TYPES: SessionType[] = [
  type('st-marco-1', 'tr-marco', 'Personal 1:1', 'Programma su misura, tecnica seguita ripetizione per ripetizione.', 60, 1, 1, 0),
  type('st-marco-2', 'tr-marco', 'Duo', 'Allenati con un amico: stesso coach, stesso programma.', 60, 2, 1, 1),
  type('st-marco-3', 'tr-marco', 'Valutazione iniziale', 'Test di partenza, obiettivi e piano di lavoro.', 45, 1, 0, 2),
  type('st-giulia-1', 'tr-giulia', 'Reformer privata', 'Lezione individuale sul reformer, ritmo e carichi su misura.', 50, 1, 1, 0),
  type('st-giulia-2', 'tr-giulia', 'Postura e mobilità', 'Schiena, anche e spalle. Ideale dopo molte ore alla scrivania.', 45, 1, 1, 1),
  type('st-giulia-3', 'tr-giulia', 'Mat in piccolo gruppo', 'Al massimo cinque persone, il mercoledì sera e il sabato mattina.', 60, 5, 1, 2),
  type('st-luca-1', 'tr-luca', 'Functional 1:1', "Forza, mobilità e condizionamento in un'ora.", 60, 1, 1, 0),
  type('st-luca-2', 'tr-luca', 'Small group', 'Fino a quattro persone, martedì e giovedì alle 19.', 60, 4, 1, 1),
  type('st-luca-3', 'tr-luca', 'Check-up', 'Misure, test e aggiornamento del programma.', 30, 1, 0, 2),
];

let windowId = 0;
const slotWindow = (trainerId: string, days: number[], start: string, end: string, location: string, sessionTypeId: string | null = null): Availability[] =>
  days.map((weekday) => ({ id: `av-${++windowId}`, trainerId, weekday, start, end, location, sessionTypeId }));

const WEEKDAYS = [1, 2, 3, 4, 5];
const AVAILABILITY: Availability[] = [
  ...slotWindow('tr-marco', WEEKDAYS, '07:00', '10:00', 'Palestra Navigli'),
  ...slotWindow('tr-marco', WEEKDAYS, '17:00', '21:00', 'Palestra Navigli'),
  ...slotWindow('tr-marco', [6], '09:00', '12:00', 'Parco Sempione'),
  ...slotWindow('tr-giulia', [1, 3, 5], '08:00', '13:00', 'Studio Prati'),
  ...slotWindow('tr-giulia', [2, 4], '15:00', '20:00', 'Studio Prati'),
  ...slotWindow('tr-giulia', [3], '19:00', '20:00', 'Studio Prati', 'st-giulia-3'),
  ...slotWindow('tr-giulia', [6], '10:00', '11:00', 'Studio Prati', 'st-giulia-3'),
  ...slotWindow('tr-luca', WEEKDAYS, '06:30', '09:30', 'Box Crocetta'),
  ...slotWindow('tr-luca', WEEKDAYS, '12:00', '14:00', 'Box Crocetta'),
  ...slotWindow('tr-luca', [1, 3, 5], '18:00', '21:00', 'Box Crocetta'),
  ...slotWindow('tr-luca', [2, 4], '18:00', '19:00', 'Box Crocetta'),
  ...slotWindow('tr-luca', [2, 4], '19:00', '20:00', 'Box Crocetta', 'st-luca-2'),
];

const product = (id: string, trainerId: string, name: string, description: string, priceCents: number, sort: number, photo: string): Product => ({
  id, trainerId, name, description, priceCents, imageUrl: `https://images.unsplash.com/${photo}?w=600&q=70&auto=format&fit=crop`,
  paymentUrl: DEMO_PAYMENT_URL, active: true, sort,
});

const PRODUCTS: Product[] = [
  product('pr-marco-1', 'tr-marco', 'Whey isolate 1 kg', 'Gusto vaniglia. La ritiri in palestra alla prossima sessione.', 3990, 0, 'photo-1774793476275-6405438753d6'),
  product('pr-marco-2', 'tr-marco', 'Kit elastici', 'Tre resistenze e una borsa, per allenarti anche in viaggio.', 2490, 1, 'photo-1584735935682-2f2b69dff9d2'),
  product('pr-marco-3', 'tr-marco', 'Shaker', 'Il logo del coach, 700 ml, va in lavastoviglie.', 1200, 2, 'photo-1642539088032-41a1fb000bc5'),
  product('pr-giulia-1', 'tr-giulia', 'Pilates ring', 'Lo stesso che usiamo in studio. Leggero e resistente.', 2900, 0, 'photo-1715780463401-b9ef0567943e'),
  product('pr-giulia-2', 'tr-giulia', 'Calze antiscivolo', 'Obbligatorie sul reformer. Taglie dalla 35 alla 46.', 1400, 1, 'photo-1747239069226-55382c570116'),
];

interface SeedSpec {
  trainerId: string;
  seed: number;
  packPrice: number;
  fill: number;
  mainType: string;
  groupType?: string;
  sara: { time: string; past: number[]; upcoming: number[]; packDaysAgo: number; sinceDays: number };
  clients: Array<{ key: string; name: string; login: boolean; since: number }>;
  referrals: Array<{ from: string; to: string; rewarded: boolean }>;
  timeOff: Array<{ weekday: number; start: string; end: string; note: string }>;
}

const SPECS: SeedSpec[] = [
  {
    trainerId: 'tr-marco',
    seed: 7,
    packPrice: 42000,
    fill: 0.34,
    mainType: 'st-marco-1',
    sara: { time: '18:30', past: [-27, -24, -20, -17, -13, -10, -6, -1], upcoming: [2], packDaysAgo: 29, sinceDays: 35 },
    clients: [
      { key: 'davide', name: 'Davide Rinaldi', login: true, since: 90 },
      { key: 'chiara', name: 'Chiara Galli', login: true, since: 61 },
      { key: 'matteo', name: 'Matteo Ferraro', login: true, since: 44 },
      { key: 'elena', name: 'Elena Marchetti', login: true, since: 12 },
      { key: 'paolo', name: 'Paolo Serra', login: true, since: 3 },
      { key: 'giorgio', name: 'Giorgio Fontana', login: false, since: 120 },
      { key: 'alessia', name: 'Alessia Rota', login: true, since: 20 },
    ],
    referrals: [
      { from: 'sara', to: 'elena', rewarded: true },
      { from: 'sara', to: 'paolo', rewarded: false },
    ],
    timeOff: [{ weekday: 5, start: '17:00', end: '21:00', note: 'Gara regionale' }],
  },
  {
    trainerId: 'tr-giulia',
    seed: 11,
    packPrice: 52000,
    fill: 0.26,
    mainType: 'st-giulia-1',
    groupType: 'st-giulia-3',
    sara: { time: '09:00', past: [-18, -14, -11, -7], upcoming: [1], packDaysAgo: 20, sinceDays: 24 },
    clients: [
      { key: 'federica', name: 'Federica Longo', login: true, since: 70 },
      { key: 'valentina', name: 'Valentina Riva', login: true, since: 40 },
      { key: 'beatrice', name: 'Beatrice Sala', login: true, since: 100 },
      { key: 'marta', name: 'Marta Colombo', login: true, since: 9 },
      { key: 'irene', name: 'Irene Pellegrini', login: true, since: 30 },
      { key: 'silvia', name: 'Silvia Neri', login: false, since: 150 },
    ],
    referrals: [{ from: 'federica', to: 'marta', rewarded: true }],
    timeOff: [],
  },
  {
    trainerId: 'tr-luca',
    seed: 13,
    packPrice: 36000,
    fill: 0.3,
    mainType: 'st-luca-1',
    groupType: 'st-luca-2',
    sara: { time: '07:30', past: [-7], upcoming: [], packDaysAgo: 9, sinceDays: 10 },
    clients: [
      { key: 'andrea', name: 'Andrea Villa', login: true, since: 80 },
      { key: 'simone', name: 'Simone Grasso', login: true, since: 50 },
      { key: 'francesca', name: 'Francesca De Luca', login: true, since: 35 },
      { key: 'lorenzo', name: 'Lorenzo Bruno', login: true, since: 2 },
      { key: 'nicola', name: 'Nicola Barbieri', login: false, since: 200 },
      { key: 'camilla', name: 'Camilla Esposito', login: true, since: 15 },
    ],
    referrals: [{ from: 'andrea', to: 'lorenzo', rewarded: false }],
    timeOff: [{ weekday: 3, start: '12:00', end: '14:00', note: 'Formazione' }],
  },
];

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyDB(now: number): DemoDB {
  return {
    version: DEMO_VERSION,
    seededAt: now,
    trainers: [],
    users: [],
    sessionTypes: [],
    availability: [],
    timeOff: [],
    clients: [],
    bookings: [],
    packs: [],
    ledger: [],
    referrals: [],
    products: [],
  };
}

export function buildSeed(now: number): DemoDB {
  const db = emptyDB(now);
  db.trainers = DEMO_TRAINERS.map((t) => ({ ...t, theme: { ...t.theme } }));
  db.users.push({ id: DEMO_USER, email: DEMO_EMAIL }, ...db.trainers.map((t) => ({ id: t.ownerUserId, email: `${t.slug}@example.com` })));
  db.sessionTypes = SESSION_TYPES.map((s) => ({ ...s }));
  db.availability = AVAILABILITY.map((a) => ({ ...a }));
  db.products = PRODUCTS.map((p) => ({ ...p }));
  for (const spec of SPECS) seedTrainer(db, spec, now);
  return db;
}

function seedTrainer(db: DemoDB, spec: SeedSpec, now: number): void {
  const t = db.trainers.find((x) => x.id === spec.trainerId)!;
  const tz = t.timezone;
  const today = localParts(now, tz).date;
  const rand = mulberry32(spec.seed);
  let n = 0;
  const id = (prefix: string) => `${prefix}-${t.slug}-${++n}`;
  const iso = (ms: number) => new Date(ms).toISOString();
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

  for (const off of spec.timeOff) {
    let date = addDays(today, 1);
    while (isoWeekday(date) !== off.weekday) date = addDays(date, 1);
    db.timeOff.push({ id: id('off'), trainerId: t.id, startsAt: iso(zonedToUtc(date, off.start, tz)!), endsAt: iso(zonedToUtc(date, off.end, tz)!), note: off.note });
  }

  const clients = new Map<string, Client>();
  const codes = new Set<string>();
  const addClient = (key: string, name: string, userId: string | null, email: string | null, sinceDays: number) => {
    const code = newReferralCode((c) => codes.has(c), rand);
    codes.add(code);
    const createdAt = iso(now - sinceDays * DAY);
    const c: Client = {
      id: id('cl'),
      trainerId: t.id,
      userId,
      name,
      email,
      phone: null,
      referralCode: code,
      termsAcceptedAt: userId ? createdAt : null,
      termsVersion: userId ? t.termsVersion : null,
      createdAt,
      deletedAt: null,
    };
    db.clients.push(c);
    clients.set(key, c);
    if (userId && userId !== DEMO_USER) db.users.push({ id: userId, email: email! });
  };
  addClient('sara', 'Sara Conti', DEMO_USER, DEMO_EMAIL, spec.sara.sinceDays);
  for (const c of spec.clients) {
    const email = `${c.key}.${t.slug.split('-')[0]}@example.com`;
    addClient(c.key, c.name, c.login ? `u-${t.slug}-${c.key}` : null, email, c.since);
  }

  const pendingOnly = new Set<string>();
  for (const r of spec.referrals) {
    const to = clients.get(r.to)!;
    db.referrals.push({
      id: id('ref'),
      trainerId: t.id,
      referrerClientId: clients.get(r.from)!.id,
      referredClientId: to.id,
      status: 'pending',
      createdAt: to.createdAt,
      rewardedAt: null,
      reversedAt: null,
    });
    if (!r.rewarded) pendingOnly.add(to.id);
  }

  const types = db.sessionTypes.filter((s) => s.trainerId === t.id);
  const main = types.find((s) => s.id === spec.mainType)!;
  const group = spec.groupType ? types.find((s) => s.id === spec.groupType) : undefined;
  const avail = db.availability.filter((a) => a.trainerId === t.id);
  const offs = db.timeOff.filter((o) => o.trainerId === t.id);
  const mine = () => db.bookings.filter((b) => b.trainerId === t.id);
  const candidatesOn = (st: SessionType, date: string, windows = avail) =>
    candidateSlots({ rules: t, type: st, availability: windows, timeOff: offs, bookings: mine(), from: date, days: 1 });
  const candidateAt = (st: SessionType, start: number): Candidate | undefined =>
    candidatesOn(st, localParts(start, tz).date).find((c) => Date.parse(c.startsAt) === start);
  const open = (c: Candidate | undefined) => !!c && !c.inTimeOff && c.placesLeft > 0;

  const book = (client: Client, st: SessionType, c: Candidate, bookedBy: 'client' | 'trainer', forceAttended = false) => {
    const start = Date.parse(c.startsAt);
    let status: BookingStatus = 'booked';
    if (start < now) {
      const r = rand();
      status = forceAttended ? 'attended' : r < 0.05 ? 'no_show' : r < 0.12 ? 'late_cancel' : 'attended';
    }
    const created = Math.min(now - HOUR, start - (1 + Math.floor(rand() * 4)) * DAY);
    db.bookings.push({
      id: id('bk'),
      trainerId: t.id,
      clientId: client.id,
      sessionTypeId: st.id,
      startsAt: c.startsAt,
      endsAt: iso(start + st.minutes * MINUTE),
      location: c.location,
      status,
      bookedBy,
      createdAt: iso(created),
      cancelledAt: status === 'late_cancel' ? iso(start - 6 * HOUR) : null,
    });
  };

  // Sara, the demo client: fixed rhythm so each look shows a meaningful state.
  const sara = clients.get('sara')!;
  const place = (offset: number, dir: 1 | -1): Candidate | undefined => {
    for (let k = 0; k < 7; k++) {
      const date = addDays(today, offset + dir * k);
      const start = zonedToUtc(date, spec.sara.time, tz);
      if (start === null) continue;
      if (dir === -1 && start >= now - HOUR) continue;
      if (dir === 1 && start < now + t.minNoticeHours * HOUR) continue;
      const c = candidateAt(main, start);
      if (open(c)) return c;
    }
    return undefined;
  };
  for (const off of spec.sara.past) {
    const c = place(off, -1);
    if (c) book(sara, main, c, 'client', true);
  }
  for (const off of spec.sara.upcoming) {
    const c = place(off, 1);
    if (c) book(sara, main, c, 'client');
  }

  // Everyone else fills part of the calendar, a little emptier in the future.
  const others = [...clients.values()].filter((c) => c.id !== sara.id && !pendingOnly.has(c.id));
  let turn = Math.floor(rand() * others.length);
  const nextClient = (startIso: string) => {
    for (let i = 0; i < others.length; i++) {
      const c = others[turn++ % others.length];
      if (c.createdAt < startIso) return c;
    }
    return undefined;
  };
  for (let d = -28; d <= 12; d++) {
    const date = addDays(today, d);
    for (const c of candidatesOn(main, date)) {
      const start = Date.parse(c.startsAt);
      if (start >= now && start < now + t.minNoticeHours * HOUR) continue;
      if (rand() > (start < now ? spec.fill : spec.fill * 0.6)) continue;
      const fresh = candidateAt(main, start);
      const who = nextClient(c.startsAt);
      if (!open(fresh) || !who) continue;
      book(who, main, fresh!, rand() < 0.28 ? 'trainer' : 'client');
    }
    if (group) {
      const groupWindows = avail.filter((a) => a.sessionTypeId === group.id);
      for (const c of candidatesOn(group, date, groupWindows)) {
        const start = Date.parse(c.startsAt);
        if (start >= now && start < now + t.minNoticeHours * HOUR) continue;
        const seats = 2 + Math.floor(rand() * 3);
        for (let s = 0; s < seats; s++) {
          const fresh = candidateAt(group, start);
          const who = nextClient(c.startsAt);
          if (!open(fresh) || !who || mine().some((b) => b.clientId === who.id && b.startsAt === c.startsAt)) continue;
          book(who, group, fresh!, 'client');
        }
      }
    }
  }

  // Packs and ledger, replayed in time order: a new pack whenever the balance runs out.
  const typeById = new Map(types.map((s) => [s.id, s]));
  const methods: readonly PayMethod[] = ['transfer', 'pos', 'satispay', 'cash'];
  for (const client of clients.values()) {
    let balance = 0;
    const buy = (at: number) => {
      const pack = {
        id: id('pk'),
        trainerId: t.id,
        clientId: client.id,
        credits: 10,
        priceCents: spec.packPrice,
        method: pick(methods),
        paidAt: iso(at),
        note: null,
        opId: id('op'),
        voidedAt: null,
      };
      db.packs.push(pack);
      db.ledger.push({ id: id('lg'), trainerId: t.id, clientId: client.id, delta: 10, reason: 'pack', packId: pack.id, createdAt: pack.paidAt });
      balance += 10;
      const ref = db.referrals.find((r) => r.referredClientId === client.id && r.status === 'pending');
      if (ref) {
        db.ledger.push({ id: id('lg'), trainerId: t.id, clientId: client.id, delta: t.bonusReferred, reason: 'referral', referralId: ref.id, createdAt: pack.paidAt });
        db.ledger.push({ id: id('lg'), trainerId: t.id, clientId: ref.referrerClientId, delta: t.bonusReferrer, reason: 'referral', referralId: ref.id, createdAt: pack.paidAt });
        ref.status = 'rewarded';
        ref.rewardedAt = pack.paidAt;
        balance += t.bonusReferred;
      }
    };
    if (client.id === sara.id) buy(now - spec.sara.packDaysAgo * DAY);
    const list = mine()
      .filter((b) => b.clientId === client.id)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (const b of list) {
      const cost = typeById.get(b.sessionTypeId)!.credits;
      if (cost <= 0) continue;
      if (balance < cost) buy(Date.parse(b.createdAt) - HOUR);
      db.ledger.push({ id: id('lg'), trainerId: t.id, clientId: client.id, delta: -cost, reason: 'booking', bookingId: b.id, createdAt: b.createdAt });
      balance -= cost;
    }
  }
}
