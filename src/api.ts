// Everything the UI can do, as one interface with two implementations:
//   src/demo.ts      the whole backend in the browser (the free demo, no server)
//   src/supabase.ts  production, calling the SQL functions in supabase/migrations
import type {
  Booking,
  Client,
  LedgerEntry,
  PackPurchase,
  PayMethod,
  Product,
  Referral,
  ReferralStatus,
  SessionType,
  Slot,
  TimeOff,
  TrainerPublic,
} from './domain.ts';

export interface Me {
  userId: string | null;
  email: string | null;
  client: Client | null; // null: signed in but not yet a client of this trainer
  isOwner: boolean;
}

export interface ReferralView {
  id: string;
  name: string; // first name only
  status: ReferralStatus;
  createdAt: string;
  rewardedAt: string | null;
}

export interface TrainerData {
  clients: Client[];
  bookings: Booking[];
  ledger: LedgerEntry[];
  referrals: Referral[];
  packs: PackPurchase[];
  timeOff: TimeOff[];
}

export interface JoinInput {
  name: string;
  phone?: string;
  referralCode?: string;
  acceptTerms: boolean;
}

export interface PackInput {
  credits: number;
  priceCents?: number | null;
  method: PayMethod;
  note?: string;
  opId: string; // one per tap: a retry never adds credits twice
}

export interface Api {
  readonly mode: 'demo' | 'live';
  getTrainer(key: string): Promise<TrainerPublic>;
  sessionTypes(trainerId: string): Promise<SessionType[]>;
  products(trainerId: string): Promise<Product[]>;

  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  me(trainerId: string): Promise<Me>;
  join(trainerId: string, input: JoinInput): Promise<Client>;

  myLedger(trainerId: string): Promise<LedgerEntry[]>;
  myBookings(trainerId: string): Promise<Booking[]>;
  myReferrals(trainerId: string): Promise<ReferralView[]>;
  freeSlots(sessionTypeId: string, from: string, days: number): Promise<Slot[]>;
  book(sessionTypeId: string, startsAt: string): Promise<Booking>;
  cancel(bookingId: string): Promise<Booking>;
  deleteAccount(trainerId: string): Promise<void>;

  trainerData(trainerId: string): Promise<TrainerData>;
  addClient(trainerId: string, input: { name: string; email?: string; phone?: string }): Promise<Client>;
  bookFor(clientId: string, sessionTypeId: string, startsAt: string): Promise<Booking>;
  markPackPaid(clientId: string, input: PackInput): Promise<{ packId: string; rewarded: boolean }>;
  voidPack(packId: string): Promise<void>;
  adjustCredits(clientId: string, delta: number, note: string, opId: string): Promise<void>;
  setAttendance(bookingId: string, status: 'attended' | 'no_show'): Promise<Booking>;
  reverseReferral(referralId: string): Promise<void>;
  addTimeOff(trainerId: string, startsAt: string, endsAt: string, note?: string): Promise<TimeOff>;
  removeTimeOff(id: string): Promise<void>;
}

// Our names first, then the ones Netlify's Supabase extension sets (VITE_SUPABASE_DATABASE_URL is the
// project's https URL despite its name) and the one Supabase's dashboard suggests for the new keys.
const SUPABASE_URL: string | undefined = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_DATABASE_URL;
const SUPABASE_KEY: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const DEMO_MODE = !SUPABASE_URL;
export const DEFAULT_DEMO_TRAINER = 'marco-bellini';

/** Demo when no Supabase project is configured (the free Netlify demo), live otherwise. */
export async function createApi(): Promise<Api> {
  if (DEMO_MODE) {
    const { createDemoApi, browserStorage } = await import('./demo.ts');
    return createDemoApi({ storage: browserStorage(), latencyMs: 160 });
  }
  const { createSupabaseApi } = await import('./supabase.ts');
  return createSupabaseApi(SUPABASE_URL as string, SUPABASE_KEY as string);
}

/**
 * Which trainer this app is. Order matters:
 *   1. VITE_TRAINER  store binaries (Capacitor has no hostname to read)
 *   2. ?t=<slug>     demo and local development
 *   3. <slug>.<VITE_APP_BASE_DOMAIN>
 *   4. the hostname  a trainer's own domain, e.g. app.mariorossi.it
 */
export function trainerKey(loc: Pick<Location, 'hostname' | 'search'> = location): string | null {
  const baked = import.meta.env.VITE_TRAINER as string | undefined;
  if (baked) return baked;
  // ?t= only in the demo and in development: in production a trainer's domain must never show another trainer.
  const fromQuery = DEMO_MODE || import.meta.env.DEV ? new URLSearchParams(loc.search).get('t') : null;
  if (fromQuery) return fromQuery;
  const host = loc.hostname.toLowerCase();
  const base = (import.meta.env.VITE_APP_BASE_DOMAIN as string | undefined)?.toLowerCase();
  if (base && host.endsWith(`.${base}`)) return host.slice(0, -(base.length + 1));
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.netlify.app')) return null;
  return host;
}
