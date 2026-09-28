// The edge function gives each installed app its trainer's name, color and icon. Demo mode (no
// Supabase): trainers come from the seed, and the demo's own brand from its link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandParam } from '../src/demoBrand.ts';

(globalThis as { Netlify?: unknown }).Netlify = { env: { get: () => undefined } };
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

test('an unknown trainer gets the generic manifest and icon', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await (await get('/manifest.webmanifest?t=nessuno')).text(), 'generic');
  const icon = await get('/app-icon.svg?t=nessuno');
  assert.equal(icon.status, 302);
  assert.equal(icon.headers.get('location'), `${origin}/icon.svg`);
});
