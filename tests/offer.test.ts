// The preview quotes this week's offer. It must stop on its own: a trainer opening an old link next month
// must see the list price, not a discount that ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM_URL, LIST_PRICE, OFFER_DISCOUNT, OFFER_PRICE, formLink, monthlyPrice, whatsappLink } from '../src/offer.ts';

const at = (iso: string) => Date.parse(iso);

test('the offer prices are the list prices minus 35%, rounded to the euro', () => {
  for (const plan of ['web', 'pro', 'store'] as const) {
    assert.equal(OFFER_PRICE[plan], Math.round(LIST_PRICE[plan] * (1 - OFFER_DISCOUNT / 100)), plan);
  }
});

test('during the offer the price is discounted and the list price is shown crossed out', () => {
  assert.deepEqual(monthlyPrice('web', at('2026-10-08T12:00:00+02:00')), { price: 69, was: 106, daysLeft: 4 });
  assert.deepEqual(monthlyPrice('pro', at('2026-10-11T23:30:00+02:00')), { price: 99, was: 152, daysLeft: 1 });
});

test('the offer includes all of Sunday 11 October and ends at midnight', () => {
  assert.equal(monthlyPrice('web', at('2026-10-11T23:59:59+02:00')).price, 69);
  assert.deepEqual(monthlyPrice('web', at('2026-10-12T00:00:00+02:00')), { price: 106, was: null, daysLeft: null });
  assert.equal(monthlyPrice('store', at('2027-01-15T10:00:00+01:00')).price, 198);
});

test('the form link carries the name, the look, the plan and the preview, and nothing breaks on odd names', () => {
  const url = new URL(formLink({ name: ' Nicolò & Figli «PT» ', template: 'luxe', plan: 'pro', colors: '#0F4C4A, #D8C3A0' }, 'https://x.test/?t=a&brand=b'));
  assert.equal(url.origin + url.pathname, FORM_URL);
  assert.equal(url.searchParams.get('nome'), 'Nicolò & Figli «PT»');
  assert.equal(url.searchParams.get('stile'), 'luxe');
  assert.equal(url.searchParams.get('piano'), 'pro');
  assert.equal(url.searchParams.get('colori'), '#0F4C4A, #D8C3A0');
  assert.equal(url.searchParams.get('anteprima'), 'https://x.test/?t=a&brand=b');
});

test('the WhatsApp link opens a chat with Manuel with the app name in the message', () => {
  const url = new URL(whatsappLink('Mario Rossi PT'));
  assert.equal(url.hostname, 'wa.me');
  assert.equal(url.pathname, '/393248423657');
  assert.match(url.searchParams.get('text') ?? '', /«Mario Rossi PT»/);
});
