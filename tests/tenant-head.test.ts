// The edge function gives each installed app its trainer's name, color and icon. Demo mode (no
// Supabase): trainers come from the seed, and the demo's own brand from its link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandParam } from '../src/demoBrand.ts';

const netlifyEnv = { get: (_name: string): string | undefined => undefined };
(globalThis as { Netlify?: unknown }).Netlify = { env: netlifyEnv };
const { default: tenantHead } = await import('../netlify/edge-functions/tenant-head.ts');

const origin = 'https://demo.netlify.app';
const next = async () => new Response('generic');
const get = (path: string) => tenantHead(new Request(origin + path), { next });

test('an installed demo brand keeps its name, color and link', async () => {
  const brand = brandParam({ name: 'Nicolò Ferraris', tagline: 'Pilates a Torino', template: 'luxe', plan: 'pro', theme: { brand: '#0F4C4A', mode: 'auto' } });
  const m = await (await get(`/manifest.webmanifest?t=il-tuo-brand&brand=${brand}`)).json();
  assert.equal(m.name, 'Nicolò Ferraris');
  assert.equal(m.theme_color, '#0F4C4A');
  assert.equal(m.start_url, `/?t=il-tuo-brand&brand=${brand}`);
  assert.equal(m.icons[0].src, `/app-icon.svg?t=il-tuo-brand&brand=${brand}`);
});

test('without a logo the icon is the initials on the brand color', async () => {
  const res = await get('/app-icon.svg?t=giulia-ferri');
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  const svg = await res.text();
  assert.match(svg, /<rect [^>]*fill="#0F4C4A"/);
  assert.match(svg, />GF<\/text>/);
});

test('the names set by Netlify’s Supabase extension switch the app to live', async (t) => {
  t.mock.method(console, 'error', () => {});
  const vars: Record<string, string> = { SUPABASE_DATABASE_URL: 'https://ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
  t.mock.method(netlifyEnv, 'get', (name: string) => vars[name]);
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('[]'); // no trainer with this name yet
  });

  assert.equal(await (await get('/manifest.webmanifest?t=giulia-ferri')).text(), 'generic');
  assert.equal(calls[0].url, 'https://ref.supabase.co/rest/v1/rpc/trainer_public');
  assert.equal(JSON.parse(String(calls[0].init?.body)).p_key, 'marco-bellini'); // ?t= is ignored on a live site
  assert.deepEqual(calls[0].init?.headers, { apikey: 'sb_publishable_x', 'content-type': 'application/json' });
});

test('an unknown trainer gets the generic manifest and icon', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await (await get('/manifest.webmanifest?t=nessuno')).text(), 'generic');
  const icon = await get('/app-icon.svg?t=nessuno');
  assert.equal(icon.status, 302);
  assert.equal(icon.headers.get('location'), `${origin}/icon.svg`);
});
