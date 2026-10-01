// A local stand-in for the two Supabase services that src/supabase.ts reaches through supabase-js:
// Auth (GoTrue: email-code sign-in) and the Data API (PostgREST: rpc, select, insert, delete).
// It serves them on 127.0.0.1 from PGlite with the real migrations applied. Every Data API request
// runs in its own transaction under the role and JWT claims PostgREST would set, so grants, row
// level security and the SECURITY DEFINER checks run for real. Status codes and error bodies copy
// the real servers wherever the adapter reads them; anything not emulated answers 501, loudly.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── the database ────────────────────────────────────────────────────────────

// What the migrations expect from a Supabase project: the API roles with Supabase's default grants
// on public, auth.users with the columns GoTrue writes, owned by GoTrue's own role (not a
// superuser, so triggers on auth.users run with the rights they would have), and auth.uid() as
// Supabase defines it.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth authorization supabase_auth_admin;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    aud text default 'authenticated',
    role text default 'authenticated',
    email text,
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    raw_app_meta_data jsonb default '{"provider": "email", "providers": ["email"]}',
    raw_user_meta_data jsonb default '{}',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  alter table auth.users owner to supabase_auth_admin;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
`;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);

/** A fresh database: the Supabase pieces above, then every migration in order, as `supabase db push` would. */
export async function supabaseDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`set timezone to 'UTC'`); // PGlite takes the host's zone; Supabase runs in UTC
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  return db;
}

// ── tokens: HS256, like a project on the legacy JWT secret ──────────────────

const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'; // the Supabase CLI's local secret
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const hmac = (data: string) => createHmac('sha256', JWT_SECRET).update(data).digest();
function sign(claims: Json): string {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${data}.${hmac(data).toString('base64url')}`;
}
/** The claims of a genuine token, 'expired', or null for anything forged or malformed. */
function verify(token: string): Json | 'expired' | null {
  const [head, body, sig, ...extra] = token.split('.');
  if (!head || !body || !sig || extra.length) return null;
  const want = hmac(`${head}.${body}`);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!isObject(claims)) return null;
    return typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now() ? 'expired' : claims;
  } catch {
    return null;
  }
}
const bearer = (req: IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];

// ── replies ─────────────────────────────────────────────────────────────────

/** One HTTP answer. Thrown to fail a request; thrown inside a transaction, it also rolls it back. */
class Reply extends Error {
  status: number;
  body: string;
  headers: Record<string, string>;
  constructor(status: number, body?: unknown, headers: Record<string, string> = {}) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    this.headers = this.body ? { 'content-type': 'application/json; charset=utf-8', ...headers } : headers;
  }
}
const pgrst = (status: number, code: string, message: string, details: string | null = null, hint: string | null = null) =>
  new Reply(status, { code, details, hint, message });
const unsupported = (what: string) => new Reply(501, { code: 'EMULATOR', details: null, hint: null, message: `the fake Supabase does not emulate ${what}` });
// GoTrue answers in the 2024-01-01 error format, and says so, when the client asks for that version (auth-js always does).
const authError = (status: number, code: string, message: string) => new Reply(status, { code, message }, { 'x-supabase-api-version': '2024-01-01' });

// PostgREST's SQLSTATE to HTTP status table (docs: Errors > HTTP status codes); anything else is 400.
const BY_CODE: Record<string, number> = { '23503': 409, '23505': 409, '25006': 405, '42883': 404, '42P01': 404, '42P17': 500, '53400': 500, P0001: 400 };
const BY_CLASS: Record<string, number> = {
  '08': 503, '09': 500, '0L': 403, '0P': 403, '25': 500, '28': 403, '2D': 500, '38': 500, '39': 500, '3B': 500,
  '40': 500, '53': 503, '54': 500, '55': 500, '57': 500, '58': 500, F0: 500, HV: 500, P0: 500, XX: 500,
};
function fromPostgres(e: unknown, role: string): Reply {
  const err = isObject(e) ? e : {};
  const code = typeof err.code === 'string' ? err.code : '';
  if (!code) return new Reply(500, { code: 'EMULATOR', details: null, hint: null, message: String(e) });
  // insufficient privilege: 401 for the anonymous role, 403 once signed in
  const status = code === '42501' ? (role === 'anon' ? 401 : 403) : (BY_CODE[code] ?? BY_CLASS[code.slice(0, 2)] ?? 400);
  const body = { code, details: err.detail ?? null, hint: err.hint ?? null, message: String(err.message ?? '') };
  return new Reply(status, body, status === 401 ? { 'www-authenticate': 'Bearer' } : {});
}

// ── the server ──────────────────────────────────────────────────────────────

export interface FakeSupabase {
  url: string;
  anonKey: string;
  /** The project's service_role key: the Edge Function's, which bypasses row level security. */
  serviceKey: string;
  /** The last sign-in code "emailed" to this address, like reading the local Supabase inbox. */
  codeFor(email: string): string;
  /** Ends every session of a user, as signing out everywhere from another device does. */
  endSessions(userId: string): void;
  /** Cuts the connection of the next request to this path, as a network failure mid-flow does. */
  dropNext(path: string): void;
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Runs first in every Data API transaction, already as the request's role (a test clock, say). */
  onTransaction?: (tx: Transaction) => Promise<unknown>;
  /** GoTrue emails one user at most once a minute by default (SMTP max frequency). */
  emailEveryMs?: number;
  /** PostgREST's max-rows; Supabase projects default to 1000. */
  maxRows?: number;
}

interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at: Date | null;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
  raw_user_meta_data: Json | null;
}
interface Who {
  role: string;
  claims: Json;
}
interface Routine {
  args: { name: string; type: string; optional: boolean }[];
  kind: 'void' | 'scalar' | 'rows';
  set: boolean;
  readOnly: boolean;
  signature: string;
}

const OTP_TTL_MS = 3_600_000; // GoTrue's default OTP lifetime
const SESSION_SECONDS = 3600;
const APP_META = { provider: 'email', providers: ['email'] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

export async function startFakeSupabase(db: PGlite, opts: FakeOptions = {}): Promise<FakeSupabase> {
  const emailEveryMs = opts.emailEveryMs ?? 60_000;
  const maxRows = opts.maxRows ?? 1000;
  const anonKey = sign({ iss: 'supabase-demo', role: 'anon', exp: 1983812996 }); // the Supabase CLI's local anon key
  const serviceKey = sign({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 }); // and its local service_role key
  const sent = new Map<string, { code: string | null; at: number }>(); // by user id
  const inbox = new Map<string, string>(); // by email
  const sessions = new Map<string, string>(); // session id -> user id
  const drop = new Set<string>(); // paths whose next request loses its connection
  let url = '';

  // ── Auth (GoTrue) ─────────────────────────────────────────────────────────

  /** GoTrue's own database connection: the supabase_auth_admin role. */
  const asGoTrue = <T>(fn: (tx: Transaction) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.query('set local role supabase_auth_admin');
      return fn(tx);
    });
  const USER = 'id, email, email_confirmed_at, last_sign_in_at, created_at, updated_at, raw_user_meta_data';
  const userBy = (col: 'id' | 'email', v: string) =>
    asGoTrue(async (tx) => (await tx.query<AuthUser>(`select ${USER} from auth.users where ${col === 'id' ? 'id = $1::uuid' : 'lower(email) = $1'}`, [v])).rows[0]);
  const userJson = (u: AuthUser) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.email_confirmed_at,
    phone: '',
    confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at,
    app_metadata: APP_META,
    user_metadata: { ...u.raw_user_meta_data, email: u.email, email_verified: u.email_confirmed_at !== null, phone_verified: false, sub: u.id },
    identities: [],
    created_at: u.created_at,
    updated_at: u.updated_at,
    is_anonymous: false,
  });
  const emailOf = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : ''); // GoTrue stores emails lowercased

  async function sendOtp(p: Json): Promise<Reply> {
    const email = emailOf(p.email);
    if (!email) throw authError(400, 'validation_failed', 'One of email or phone must be set');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError(400, 'email_address_invalid', `Email address "${email}" is invalid`);
    let user = await userBy('email', email);
    if (!user) {
      if (p.create_user === false) throw authError(422, 'otp_disabled', 'Signups not allowed for otp');
      // a new user starts unconfirmed ("Confirm email" on): the first verified code confirms the address
      const meta = JSON.stringify(isObject(p.data) ? p.data : {});
      user = await asGoTrue(async (tx) => (await tx.query<AuthUser>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::text::jsonb) returning ${USER}`, [email, meta])).rows[0]);
    }
    const last = sent.get(user.id);
    const wait = last ? Math.ceil((last.at + emailEveryMs - Date.now()) / 1000) : 0;
    if (wait > 0) throw authError(429, 'over_email_send_rate_limit', `For security purposes, you can only request this after ${wait} seconds.`);
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    sent.set(user.id, { code, at: Date.now() });
    inbox.set(email, code);
    return new Reply(200, {});
  }

  async function verifyOtp(p: Json): Promise<Reply> {
    if (!['email', 'magiclink', 'signup'].includes(String(p.type))) throw unsupported(`verifying a "${String(p.type)}" token`);
    const email = emailOf(p.email);
    const token = typeof p.token === 'string' ? p.token.trim() : '';
    if (!email || !token) throw authError(400, 'validation_failed', 'Verify requires an email and a token');
    const user = await userBy('email', email);
    const code = user && sent.get(user.id);
    // unknown user, wrong code, used code, old code: one answer for all, like GoTrue
    if (!user || !code?.code || code.code !== token || Date.now() - code.at > OTP_TTL_MS) throw authError(403, 'otp_expired', 'Token has expired or is invalid');
    code.code = null; // one use; the send time still counts for the rate limit
    const u = await asGoTrue(async (tx) => {
      // confirming touches email_confirmed_at only once, so on-confirm triggers fire like on the real server
      await tx.query(`update auth.users set email_confirmed_at = now(), updated_at = now() where id = $1 and email_confirmed_at is null`, [user.id]);
      return (await tx.query<AuthUser>(`update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1 returning ${USER}`, [user.id])).rows[0];
    });
    const sessionId = randomUUID();
    sessions.set(sessionId, u.id);
    const iat = Math.floor(Date.now() / 1000);
    const access_token = sign({
      iss: `${url}/auth/v1`,
      sub: u.id,
      aud: 'authenticated',
      exp: iat + SESSION_SECONDS,
      iat,
      email: u.email,
      phone: '',
      app_metadata: APP_META,
      user_metadata: userJson(u).user_metadata,
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'otp', timestamp: iat }],
      session_id: sessionId,
      is_anonymous: false,
    });
    return new Reply(200, {
      access_token,
      token_type: 'bearer',
      expires_in: SESSION_SECONDS,
      expires_at: iat + SESSION_SECONDS,
      refresh_token: randomBytes(9).toString('base64url'),
      user: userJson(u),
    });
  }

  /** GoTrue's requireAuthentication: a genuine token, a user that still exists, a session still open. */
  async function authenticate(req: IncomingMessage): Promise<{ user: AuthUser; sessionId: string | null }> {
    const token = bearer(req);
    if (!token) throw authError(401, 'no_authorization', 'This endpoint requires a valid Bearer token');
    const claims = verify(token);
    if (claims === 'expired') throw authError(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired');
    if (!claims) throw authError(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, token signature is invalid');
    if (typeof claims.sub !== 'string' || !claims.sub) throw authError(403, 'bad_jwt', 'invalid claim: missing sub claim');
    if (!UUID.test(claims.sub)) throw authError(400, 'bad_jwt', 'invalid claim: sub claim must be a UUID');
    const user = await userBy('id', claims.sub);
    if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null;
    if (sessionId && !sessions.has(sessionId)) throw authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    return { user, sessionId };
  }

  async function logout(req: IncomingMessage, scope: string): Promise<Reply> {
    if (!['global', 'local', 'others'].includes(scope)) throw authError(400, 'validation_failed', `Unsupported logout scope "${scope}"`);
    const { user, sessionId } = await authenticate(req);
    for (const [id, owner] of sessions) {
      if (owner !== user.id) continue;
      // a token without a session id signs out everywhere, as in GoTrue
      if (!sessionId || scope === 'global' || (scope === 'local' ? id === sessionId : id !== sessionId)) sessions.delete(id);
    }
    return new Reply(204);
  }

  async function auth(req: IncomingMessage, u: URL, body: string): Promise<Reply> {
    const route = `${req.method} ${u.pathname.slice('/auth/v1'.length)}`;
    let p: unknown = {};
    if (body) {
      try {
        p = JSON.parse(body);
      } catch (e) {
        throw authError(400, 'bad_json', `Could not parse request body as JSON: ${String(e)}`);
      }
    }
    const params = isObject(p) ? p : {};
    if (route === 'POST /otp') return sendOtp(params);
    if (route === 'POST /verify') return verifyOtp(params);
    if (route === 'GET /user') return new Reply(200, userJson((await authenticate(req)).user));
    if (route === 'POST /logout') return logout(req, u.searchParams.get('scope') ?? 'global');
    throw unsupported(`${route} on Auth`);
  }

  // ── Data API (PostgREST) ──────────────────────────────────────────────────

  /** The role and claims PostgREST takes from the Authorization header; no token is the anon role. */
  function who(req: IncomingMessage): Who {
    const token = bearer(req);
    if (!token) return { role: 'anon', claims: {} };
    const claims = verify(token);
    if (claims === 'expired') throw new Reply(401, { code: 'PGRST303', details: null, hint: null, message: 'JWT expired' }, { 'www-authenticate': 'Bearer error="invalid_token", error_description="JWT expired"' });
    if (!claims) throw new Reply(401, { code: 'PGRST301', details: null, hint: null, message: 'JWSError JWSInvalidSignature' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
    return { role: typeof claims.role === 'string' ? claims.role : 'anon', claims };
  }

  /** One request, one transaction: role and claims set locally, read-only when PostgREST would be. */
  async function inTx(w: Who, readOnly: boolean, fn: (tx: Transaction) => Promise<Reply>): Promise<Reply> {
    try {
      return await db.transaction(async (tx) => {
        if (readOnly) await tx.query('set transaction read only');
        await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true)`, [
          w.role,
          JSON.stringify(w.claims),
          typeof w.claims.sub === 'string' ? w.claims.sub : '',
        ]);
        await opts.onTransaction?.(tx);
        return await fn(tx);
      });
    } catch (e) {
      throw e instanceof Reply ? e : fromPostgres(e, w.role);
    }
  }

  const parseJson = (body: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      throw pgrst(400, 'PGRST102', 'Empty or invalid json');
    }
  };

  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);
  const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const IS: Record<string, string> = { null: 'null', not_null: 'not null', true: 'true', false: 'false', unknown: 'unknown' };

  /** Horizontal filters: col=op.value, optionally not.op.value. Values stay untyped literals, as in PostgREST. */
  function where(u: URL, rel: string): string {
    const terms: string[] = [];
    for (const [col, raw] of u.searchParams) {
      if (RESERVED.has(col)) continue;
      const not = raw.startsWith('not.');
      const [op = '', ...rest] = (not ? raw.slice(4) : raw).split('.');
      const val = rest.join('.');
      let term: string;
      if (Object.hasOwn(OPS, op)) term = `${rel}.${ident(col)} ${OPS[op]} ${lit(val)}`;
      else if (op === 'is' && Object.hasOwn(IS, val.toLowerCase())) term = `${rel}.${ident(col)} is ${IS[val.toLowerCase()]}`;
      else throw unsupported(`the filter ${col}=${raw}`);
      terms.push(not ? `not (${term})` : term);
    }
    return terms.length ? ` where ${terms.join(' and ')}` : '';
  }

  function orderBy(u: URL, rel: string): string {
    const raw = u.searchParams.get('order');
    if (!raw) return '';
    const terms = raw.split(',').map((term) => {
      const [col = '', ...mods] = term.split('.');
      let sql = `${rel}.${ident(col)}`;
      for (const m of mods) {
        if (m === 'asc' || m === 'desc') sql += ` ${m}`;
        else if (m === 'nullsfirst' || m === 'nullslast') sql += ` nulls ${m.slice(5)}`;
        else throw pgrst(400, 'PGRST100', `"failed to parse order (${raw})"`);
      }
      return sql;
    });
    return ` order by ${terms.join(', ')}`;
  }

  function projection(u: URL, rel: string): string {
    const s = u.searchParams.get('select') ?? '*';
    if (s === '*') return `${rel}.*`;
    const cols = s.split(',');
    if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/i.test(c))) throw unsupported(`select=${s} (only * or plain column lists)`);
    return cols.map((c) => `${rel}.${ident(c)}`).join(', ');
  }

  /** limit/offset, intersected with a Range header (GET only) and capped at max-rows. */
  function window(u: URL, range?: string): { offset: number; limit: number } {
    const int = (k: string) => {
      const v = u.searchParams.get(k);
      if (v === null) return undefined;
      if (!/^\d+$/.test(v)) throw pgrst(400, 'PGRST103', `"failed to parse ${k} parameter (${v})"`);
      return Number(v);
    };
    let lo = int('offset') ?? 0;
    const limit = int('limit');
    let hi = limit === undefined ? Infinity : lo + limit - 1;
    const m = range ? /^(\d+)-(\d*)$/.exec(range.trim()) : null;
    if (m) {
      lo = Math.max(lo, Number(m[1]));
      if (m[2]) hi = Math.min(hi, Number(m[2]));
    }
    hi = Math.min(hi, lo + maxRows - 1);
    return { offset: lo, limit: Math.max(0, hi - lo + 1) };
  }

  /** Runs a row query and answers with a JSON array, or one object when the client asked for one. */
  async function answer(tx: Transaction, status: number, select: string, params: unknown[], single: boolean, offset: number, cte = ''): Promise<Reply> {
    const { rows } = await tx.query<{ body: string; first: string | null; n: number }>(
      `${cte} select coalesce(json_agg(pgrst_t), '[]')::text as body, (json_agg(pgrst_t) -> 0)::text as first, count(*)::int as n from (${select}) pgrst_t`,
      params,
    );
    const r = rows[0];
    const range = r.n ? `${offset}-${offset + r.n - 1}/*` : '*/*';
    if (!single) return new Reply(status, r.body, { 'content-range': range });
    // thrown, so a write that returned the wrong number of rows is rolled back, as in PostgREST
    if (r.n !== 1) throw pgrst(406, 'PGRST116', 'Cannot coerce the result to a single JSON object', `The result contains ${r.n} rows`);
    return new Reply(status, r.first ?? 'null', { 'content-type': 'application/vnd.pgrst.object+json; charset=utf-8', 'content-range': range });
  }

  async function routines(name: string): Promise<Routine[]> {
    const { rows } = await db.query<{ args: string; nargs: number; ndefaults: number; volatility: string; retset: boolean; rettype: string; typtype: string; signature: string }>(
      `select coalesce((select json_agg(json_build_object('name', a.name, 'type', format_type(a.type, null), 'mode', a.mode) order by a.ord)
                          from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]), p.proargnames,
                                      coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs]::int[]))) with ordinality a(type, name, mode, ord)), '[]')::text as args,
              p.pronargs::int as nargs, p.pronargdefaults::int as ndefaults, p.provolatile::text as volatility, p.proretset as retset,
              t.typname::text as rettype, t.typtype::text as typtype, pg_get_function_identity_arguments(p.oid) as signature
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
        where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
      [name],
    );
    return rows.map((r) => {
      const inputs = (JSON.parse(r.args) as { name: string | null; type: string; mode: string }[]).filter((a) => 'ibv'.includes(a.mode));
      return {
        args: inputs.map((a, i) => ({ name: a.name ?? '', type: a.type, optional: i >= r.nargs - r.ndefaults })),
        kind: r.rettype === 'void' ? 'void' : r.typtype === 'c' || r.rettype === 'record' ? 'rows' : 'scalar',
        set: r.retset,
        readOnly: r.volatility !== 'v', // PostgREST runs stable and immutable functions read-only
        signature: `public.${name}(${r.signature})`,
      };
    });
  }

  async function rpc(fn: string, u: URL, body: string, w: Who, single: boolean): Promise<Reply> {
    const args = body.trim() ? parseJson(body) : {};
    if (!isObject(args)) throw unsupported('calling a function with a JSON array body');
    const keys = Object.keys(args);
    const candidates = await routines(fn);
    // PostgREST's overload choice: every required argument given, every other key an optional argument
    const found = candidates.filter((r) => {
      const required = r.args.filter((a) => !a.optional);
      const rest = keys.filter((k) => !r.args.some((a) => a.optional && a.name === k));
      return rest.length === required.length && required.every((a) => keys.includes(a.name));
    });
    if (found.length > 1) throw pgrst(300, 'PGRST203', `Could not choose the best candidate function between: ${found.map((r) => r.signature).join(', ')}`);
    const r = found[0];
    if (!r) {
      const names = [...keys].sort().join(', ');
      throw pgrst(
        404,
        'PGRST202',
        `Could not find the function public.${fn}${keys.length ? `(${names})` : ' without parameters'} in the schema cache`,
        `Searched for the function public.${fn}${keys.length ? ` with parameter${keys.length > 1 ? 's' : ''} ${names}` : ' without parameters'} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
        candidates[0] ? `Perhaps you meant to call the function ${candidates[0].signature}` : null,
      );
    }
    if (r.kind === 'scalar' && r.set) throw unsupported('functions returning a set of scalars');
    const given = r.args.filter((a) => keys.includes(a.name));
    const call = `${ident('public')}.${ident(fn)}(${given.map((a) => `${ident(a.name)} := pgrst_args.${ident(a.name)}`).join(', ')})`;
    // the arguments are read from the JSON body with the function's own types, as PostgREST does
    const from = given.length ? `json_to_record($1::text::json) as pgrst_args(${given.map((a) => `${ident(a.name)} ${a.type}`).join(', ')}) cross join lateral ` : '';
    const params = given.length ? [body] : [];
    return inTx(w, r.readOnly, async (tx) => {
      if (r.kind === 'void') {
        await tx.query(`select 1 from ${from}(select ${call}) pgrst_call`, params);
        return new Reply(204);
      }
      if (r.kind === 'scalar') {
        const { rows } = await tx.query<{ body: string | null }>(`select to_json(pgrst_call.v)::text as body from ${from}(select ${call} as v) pgrst_call`, params);
        return new Reply(200, rows[0]?.body ?? 'null');
      }
      const { offset, limit } = window(u);
      const select = `select ${projection(u, 'pgrst_call')} from ${from}${call} pgrst_call${where(u, 'pgrst_call')}${orderBy(u, 'pgrst_call')} limit ${limit} offset ${offset}`;
      if (r.set) return answer(tx, 200, select, params, single, offset);
      // a function returning one row (not a set) answers with that object
      const one = await answer(tx, 200, select, params, true, offset);
      return new Reply(200, one.body);
    });
  }

  async function rest(req: IncomingMessage, u: URL, body: string): Promise<Reply> {
    const method = req.method ?? 'GET';
    const profile = req.headers[method === 'GET' || method === 'HEAD' ? 'accept-profile' : 'content-profile'];
    if (profile !== undefined && profile !== 'public') throw pgrst(406, 'PGRST106', 'The schema must be one of the following: public');
    const w = who(req);
    const prefer = new Set(String(req.headers.prefer ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const single = String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');
    const path = decodeURIComponent(u.pathname.slice('/rest/v1/'.length));
    const fn = /^rpc\/([^/]+)$/.exec(path)?.[1];
    if (fn !== undefined) {
      if (method !== 'POST') throw unsupported(`${method} /rpc (supabase-js calls functions with POST)`);
      return rpc(fn, u, body, w, single);
    }
    const exists = await db.query(
      `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r', 'v', 'm', 'f', 'p')`,
      [path],
    );
    if (!exists.rows.length) throw pgrst(404, 'PGRST205', `Could not find the table 'public.${path}' in the schema cache`);
    const target = `${ident('public')}.${ident(path)}`;

    if (method === 'GET') {
      const { offset, limit } = window(u, req.headers.range);
      const select = `select ${projection(u, target)} from ${target}${where(u, target)}${orderBy(u, target)} limit ${limit} offset ${offset}`;
      return inTx(w, true, (tx) => answer(tx, 200, select, [], single, offset));
    }
    const representation = prefer.has('return=representation');
    if (method === 'POST') {
      if (prefer.has('missing=default') || [...prefer].some((p) => p.startsWith('resolution=')) || u.searchParams.has('on_conflict')) throw unsupported('upserts or missing=default');
      const payload = parseJson(body);
      const list = Array.isArray(payload) ? payload : [payload];
      if (!list.every(isObject)) throw pgrst(400, 'PGRST102', 'All object keys must match');
      const cols = u.searchParams.get('columns')?.split(',').map((c) => c.trim().replace(/^"|"$/g, '')) ?? [...new Set(list.flatMap((row) => Object.keys(row)))];
      if (!cols.length) throw unsupported('inserting rows without columns');
      // keys missing from a row insert null; columns missing from every row keep their defaults
      const insert = `insert into ${target} (${cols.map(ident).join(', ')}) select ${cols.map((c) => `pgrst_body.${ident(c)}`).join(', ')} from json_populate_recordset(null::${target}, $1::text::json) pgrst_body`;
      const params = [JSON.stringify(list)];
      return inTx(w, false, async (tx) => {
        if (!representation) {
          await tx.query(insert, params);
          return new Reply(201, undefined, { 'content-range': '*/*' });
        }
        return answer(tx, 201, `select ${projection(u, 'pgrst_source')} from pgrst_source`, params, single, 0, `with pgrst_source as (${insert} returning ${target}.*)`);
      });
    }
    if (method === 'DELETE') {
      const del = `delete from ${target}${where(u, target)}`;
      return inTx(w, false, async (tx) => {
        if (!representation) {
          await tx.query(del);
          return new Reply(204, undefined, { 'content-range': '*/*' });
        }
        return answer(tx, 200, `select ${projection(u, 'pgrst_source')} from pgrst_source`, [], single, 0, `with pgrst_source as (${del} returning ${target}.*)`);
      });
    }
    throw unsupported(`${method} on tables`);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  async function handle(req: IncomingMessage): Promise<Reply> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url ?? '/', url);
    // the API gateway in front of both services only lets through requests carrying the project's key
    if (req.headers.apikey !== anonKey && req.headers.apikey !== serviceKey) {
      return new Reply(401, { message: req.headers.apikey ? 'Invalid API key' : 'No API key found in request' });
    }
    if (u.pathname.startsWith('/auth/v1/')) return auth(req, u, body);
    if (u.pathname.startsWith('/rest/v1/')) return rest(req, u, body);
    return new Reply(404, { message: 'no Route matched with those values' });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', url).pathname;
    if (drop.delete(path)) return void req.socket.destroy();
    handle(req)
      .catch((e: unknown) => (e instanceof Reply ? e : new Reply(500, { code: 'EMULATOR', details: null, hint: null, message: String(e) })))
      .then((reply) => res.writeHead(reply.status, reply.headers).end(reply.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    anonKey,
    serviceKey,
    codeFor(email) {
      const code = inbox.get(email.trim().toLowerCase());
      if (!code) throw new Error(`no sign-in code was sent to ${email}`);
      return code;
    },
    endSessions(userId) {
      for (const [id, owner] of sessions) if (owner === userId) sessions.delete(id);
    },
    dropNext(path) {
      drop.add(path);
    },
    close() {
      server.closeAllConnections();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
