// The demo's custom brand travels in the link (?brand=). The link is outside input: whatever it
// holds, the app gets a clean brand or none, never a broken page or a script URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFromParam, brandParam } from '../src/demoBrand.ts';

const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const cover = 'https://images.unsplash.com/photo-1540497077202-7c8a3999166f?w=1400&q=70';
const brand = {
  name: 'Nicolò Ferraris',
  tagline: 'Pilates reformer a Torino',
  template: 'luxe',
  plan: 'pro',
  theme: { brand: '#0F4C4A', accent: '#D8C3A0', mode: 'auto', cover },
} as const;

test('a demo brand survives the trip through a link, accents included', () => {
  const back = brandFromParam(brandParam({ ...brand, theme: { ...brand.theme } }));
  assert.deepEqual(back, { ...brand, theme: { ...brand.theme, logo: undefined } });
});

test('an uploaded logo stays on the device, an https logo travels', () => {
  const uploaded = brandFromParam(brandParam({ ...brand, theme: { ...brand.theme, logo: `data:image/png;base64,${'A'.repeat(5000)}` } }));
  assert.equal(uploaded?.theme?.logo, undefined);
  const hosted = brandFromParam(brandParam({ ...brand, theme: { ...brand.theme, logo: 'https://example.com/logo.png' } }));
  assert.equal(hosted?.theme?.logo, 'https://example.com/logo.png');
});

test('a broken or hostile link gives a clean brand or none', () => {
  assert.equal(brandFromParam(null), null);
  assert.equal(brandFromParam(''), null);
  assert.equal(brandFromParam('%%% not base64 %%%'), null);
  assert.equal(brandFromParam(encode('just a string')), null);
  assert.equal(brandFromParam(encode({ name: 'Solo nome' })), null);
  assert.equal(brandFromParam(encode({ ...brand, template: 'hacker' })), null);
  assert.equal(brandFromParam(encode({ ...brand, plan: 'free' })), null);
  assert.equal(brandFromParam(encode({ ...brand, theme: { brand: 'red' } })), null);
  assert.equal(brandFromParam(encode({ ...brand, name: 'x'.repeat(41) })), null);

  const hostile = brandFromParam(encode({ ...brand, theme: { brand: '#123456', mode: 'neon', cover: 'javascript:alert(1)', logo: 'data:text/html,<b>' } }));
  assert.deepEqual(hostile?.theme, { brand: '#123456', accent: undefined, mode: 'auto', cover: undefined, logo: undefined });
});
