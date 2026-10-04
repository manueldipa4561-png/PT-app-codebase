// The outreach tool turns a hand-filled tracker into messages ready to send. The tests pin the "no spam"
// rules: a real detail and a source for every message, nobody who opted out, one follow-up, 20 a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFromParam } from '../src/demoBrand.ts';
import { TEMPLATES } from '../src/theme.ts';
import { parseCsv, phoneDigits, planOutreach, previewLink, readTracker, renderReport, type PlanOptions, type TrackerRow } from '../src/outreach.ts';

const base = 'https://demo.example';
const privacy = 'https://example.it/privacy';
const opts: PlanOptions = { today: '2026-10-05', base, privacyUrl: privacy };

const row = (o: Partial<TrackerRow> = {}): TrackerRow => ({
  tier: 'A', score: '8', name: 'Mario Rossi', town: 'Pescara', type: 'solo', studio: '', style: '',
  instagram: '@mariorossi', businessPhone: '', businessEmail: '', sourceUrl: 'https://instagram.com/mariorossi',
  detailSeen: 'che gestisci le prenotazioni su WhatsApp', channel: 'instagram',
  firstContact: '', followUpDue: '', status: '', optedOut: '', ...o,
});
const skippedReason = (o: Partial<TrackerRow>, p: PlanOptions = opts) => planOutreach([row(o)], p).skipped[0]?.reason ?? '';

test('parseCsv reads quotes, commas inside quotes, escaped quotes, CRLF and a BOM', () => {
  const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', '']]);
});

test('readTracker maps the header to fields and refuses a file without name and tier', () => {
  const csv = 'tier,score,name,town,instagram,business_phone,source_url,detail_seen\nA,8,Mario Rossi,Pescara,@mario,,https://x.it,"le sedute a Pescara"';
  const [r] = readTracker(csv);
  assert.equal(r?.name, 'Mario Rossi');
  assert.equal(r?.businessPhone, '');
  assert.equal(r?.detailSeen, 'le sedute a Pescara');
  assert.throws(() => readTracker('town,instagram\nPescara,@x'), /name.*tier|tier.*name/);
});

test('phoneDigits gives the number wa.me expects', () => {
  assert.equal(phoneDigits('+39 333 123 4567'), '393331234567');
  assert.equal(phoneDigits('333 1234567'), '393331234567');
  assert.equal(phoneDigits('0039 333 1234567'), '393331234567');
  assert.equal(phoneDigits('085 123456'), '39085123456');
});

test('the preview link carries a brand the app can read back', () => {
  const url = new URL(previewLink(row(), base));
  assert.equal(url.origin, base);
  assert.equal(url.searchParams.get('t'), 'il-tuo-brand');
  const brand = brandFromParam(url.searchParams.get('brand'));
  assert.equal(brand?.name, 'Mario Rossi');
  assert.equal(brand?.tagline, 'Personal training a Pescara.');
  assert.equal(brand?.template, 'studio');
  assert.equal(brand?.plan, 'pro');
  assert.equal(brand?.theme?.brand, TEMPLATES.studio.sample.brand);
});

test('a first Instagram message names the person, the real detail, the preview and an easy way out', () => {
  const { ready } = planOutreach([row()], opts);
  assert.equal(ready.length, 1);
  const [m] = ready;
  assert.equal(m?.kind, 'first');
  assert.equal(m?.target, 'https://instagram.com/mariorossi');
  assert.match(m?.message ?? '', /^Ciao Mario, sono Manuel di Punto Due Studio\. Ho visto che gestisci le prenotazioni su WhatsApp\./);
  assert.ok(m?.message.includes(m.link));
  assert.match(m?.message ?? '', /non ti disturbo più/);
});

test('a WhatsApp message goes to the business number and carries the privacy link', () => {
  const { ready } = planOutreach([row({ channel: 'whatsapp', instagram: '', businessPhone: '+39 333 123 4567' })], opts);
  const [m] = ready;
  assert.ok(m?.message.includes(privacy));
  assert.ok(m?.send?.startsWith('https://wa.me/393331234567?text='));
  assert.ok(decodeURIComponent(m?.send ?? '').includes('Buongiorno Mario'));
});

test('a studio message uses the studio name, its look and the studio as the brand', () => {
  const studio = row({ type: 'studio', studio: 'Atelier Pilates', name: 'Giulia Ferri', style: 'luxe' });
  const [m] = planOutreach([studio], opts).ready;
  assert.match(m?.message ?? '', /Ho visto Atelier Pilates/);
  const brand = brandFromParam(new URL(m?.link ?? '').searchParams.get('brand'));
  assert.equal(brand?.name, 'Atelier Pilates');
  assert.equal(brand?.template, 'luxe');
});

test('nobody is messaged without a reason to', () => {
  assert.match(skippedReason({ optedOut: 'Y' }), /opted out/);
  assert.match(skippedReason({ tier: 'C' }), /tier/);
  assert.match(skippedReason({ detailSeen: '' }), /detail/);
  assert.match(skippedReason({ sourceUrl: '' }), /source/);
  assert.match(skippedReason({ status: 'replied' }), /replied/);
  assert.match(skippedReason({ name: 'x'.repeat(41) }), /40/);
  assert.match(skippedReason({ instagram: '' }), /instagram/);
  assert.match(skippedReason({ channel: 'whatsapp', businessPhone: '+39 333 123 4567' }, { today: opts.today, base }), /privacy/);
  assert.match(skippedReason({ channel: 'whatsapp', businessPhone: '' }), /phone/);
  assert.match(skippedReason({ channel: 'whatsapp', businessPhone: 'abc' }), /valid number/);
  assert.match(skippedReason({ channel: 'whatsapp', businessPhone: '12' }), /valid number/);
  assert.match(skippedReason({ channel: 'in person' }), /channel/);
});

test('one follow-up, six days after the first message, and never before', () => {
  const sent = { firstContact: '2026-09-28', status: 'contacted' };
  const due = planOutreach([row(sent)], opts).ready[0];
  assert.equal(due?.kind, 'follow-up');
  assert.match(due?.message ?? '', /una volta sola/);
  assert.match(skippedReason({ firstContact: '2026-10-03', status: 'contacted' }), /follow-up due 2026-10-09/);
  assert.match(skippedReason({ ...sent, followUpDue: '2026-10-10' }), /follow-up due 2026-10-10/);
  assert.match(skippedReason({ ...sent, status: 'followed_up' }), /followed_up/);
});

test('at most 20 a day, the strongest first', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row({ tier: 'B', score: '5', name: `Bruno ${i}` })),
    ...Array.from({ length: 20 }, (_, i) => row({ tier: 'A', score: String(7 + (i % 3)), name: `Anna ${i}` })),
  ];
  const plan = planOutreach(rows, opts);
  assert.equal(plan.ready.length, 20);
  assert.ok(plan.ready.every((m) => m.tier === 'A'));
  assert.equal(plan.skipped.filter((s) => /daily limit/.test(s.reason)).length, 5);
  assert.equal(planOutreach(rows, { ...opts, limit: 3 }).ready.length, 3);
});

test('no message states a price, and the report lists what was skipped and why', () => {
  const rows = [row(), row({ name: 'Luca Neri', channel: 'whatsapp', instagram: '', businessPhone: '333 1234567' }), row({ name: 'Ugo Bassi', optedOut: 'yes' })];
  const plan = planOutreach(rows, opts);
  for (const m of plan.ready) assert.doesNotMatch(m.message, /€|euro|\d+\s*\/\s*mese/i);
  const report = renderReport(plan, opts.today);
  assert.match(report, /2 ready, 1 skipped/);
  assert.ok(report.includes(plan.ready[0]?.link ?? 'missing'));
  assert.match(report, /Ugo Bassi: opted out/);
});
