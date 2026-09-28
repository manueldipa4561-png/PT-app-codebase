// Netlify Edge Function (Deno). Gives every trainer's app its own name, color, icon and link
// preview before any JavaScript runs, so installs and shared links show the trainer, not the
// platform. The trainer is resolved like trainerKey() in src/api.ts (that file reads import.meta.env
// at load, so it cannot be imported here). Any failure serves the page untouched.
import { DEMO_TRAINERS } from '../../src/seed.ts';
import { firstName, isHttpsUrl, type TrainerPublic } from '../../src/domain.ts';

declare const Netlify: { env: { get(name: string): string | undefined } };
interface Context {
  next(): Promise<Response>;
}
type Trainer = Pick<TrainerPublic, 'slug' | 'name' | 'tagline' | 'theme'>;

const DEFAULT_TRAINER = 'marco-bellini'; // DEFAULT_DEMO_TRAINER in src/api.ts
const BLOCK = /<!-- tenant:start[\s\S]*?<!-- tenant:end -->/;
const INVITE = 'Hai ricevuto un invito. Entra e prenota la tua prima sessione.';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const https = (u: string | undefined) => (u && isHttpsUrl(u) ? u : null);

function trainerKey(url: URL): string {
  // ?t= only in the demo (no Supabase): a live trainer domain never previews another trainer.
  const fromQuery = Netlify.env.get('SUPABASE_URL') ? null : url.searchParams.get('t');
  if (fromQuery) return fromQuery;
  const host = url.hostname.toLowerCase();
  const base = Netlify.env.get('APP_BASE_DOMAIN')?.toLowerCase();
  if (base && host.endsWith(`.${base}`)) return host.slice(0, -(base.length + 1));
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.netlify.app')) return DEFAULT_TRAINER;
  return host;
}

async function findTrainer(key: string): Promise<Trainer> {
  const supabase = Netlify.env.get('SUPABASE_URL');
  if (!supabase) {
    const demo = DEMO_TRAINERS.find((t) => t.slug === key.trim().toLowerCase());
    if (!demo) throw new Error(`no demo trainer "${key}"`);
    return demo;
  }
  const anon = Netlify.env.get('SUPABASE_ANON_KEY') ?? '';
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable_ keys never do
  // (same rule as supabase-js), the apikey header alone gives the anon role.
  const bearer = anon.startsWith('sb_publishable_') ? {} : { authorization: `Bearer ${anon}` };
  const res = await fetch(`${supabase.replace(/\/+$/, '')}/rest/v1/rpc/trainer_public`, {
    method: 'POST',
    headers: { apikey: anon, ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ p_key: key }),
    signal: AbortSignal.timeout(1500), // a slow database must not hold the page
  });
  if (!res.ok) throw new Error(`trainer_public: HTTP ${res.status}`);
  const rows: unknown = await res.json();
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) throw new Error(`no trainer "${key}"`);
  return row as Trainer;
}

function manifest(t: Trainer, demo: boolean): Response {
  const start = demo ? `/?t=${encodeURIComponent(t.slug)}` : '/';
  const logo = https(t.theme.logo);
  const body = {
    name: t.name,
    short_name: firstName(t.name).slice(0, 12),
    description: t.tagline,
    start_url: start,
    scope: '/',
    id: start,
    display: 'standalone',
    background_color: t.theme.brand,
    theme_color: t.theme.brand,
    icons: logo
      ? [{ src: logo, sizes: 'any' }]
      : [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/manifest+json', 'cache-control': 'max-age=300' },
  });
}

function headTags(t: Trainer, demo: boolean, invite: boolean): string {
  const logo = https(t.theme.logo);
  const cover = https(t.theme.cover);
  const manifestHref = demo ? `/manifest.webmanifest?t=${encodeURIComponent(t.slug)}` : '/manifest.webmanifest';
  return [
    `<title>${esc(t.name)}</title>`,
    `<meta name="description" content="${esc(t.tagline)}" />`,
    `<meta name="theme-color" content="${esc(t.theme.brand)}" />`,
    `<meta name="apple-mobile-web-app-title" content="${esc(t.name)}" />`,
    `<link rel="manifest" href="${esc(manifestHref)}" />`,
    logo && `<link rel="apple-touch-icon" href="${esc(logo)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(invite ? `${t.name} ti aspetta` : t.name)}" />`,
    `<meta property="og:description" content="${esc(invite ? INVITE : t.tagline)}" />`,
    cover && `<meta property="og:image" content="${esc(cover)}" />`,
  ]
    .filter(Boolean)
    .join('\n    ');
}

export default async function tenantHead(request: Request, context: Context): Promise<Response> {
  if (request.method !== 'GET') return context.next();
  const url = new URL(request.url);
  const demo = !Netlify.env.get('SUPABASE_URL');

  if (url.pathname === '/manifest.webmanifest') {
    try {
      return manifest(await findTrainer(trainerKey(url)), demo);
    } catch (error) {
      console.error('tenant-head', url.host, error);
      return context.next(); // the generic public/manifest.webmanifest
    }
  }

  const res = await context.next();
  if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return res;
  try {
    const trainer = await findTrainer(trainerKey(url));
    const html = await res.clone().text(); // the original stays unread, ready to fall back to
    if (!BLOCK.test(html)) throw new Error('tenant markers not found in the page');
    const headers = new Headers(res.headers);
    // The body changed: its length, encoding and the static file's validator no longer apply.
    for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
    const page = html.replace(BLOCK, () => headTags(trainer, demo, url.pathname.startsWith('/r/')));
    return new Response(page, { status: res.status, headers });
  } catch (error) {
    console.error('tenant-head', url.host, error);
    return res;
  }
}

export const config = { path: '/*', excludedPath: ['/assets/*', '/sw.js', '/icon.svg', '/favicon.ico'] };
