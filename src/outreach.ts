// Outreach: turns a tracker filled in by hand (CSV) into one-to-one messages ready to send.
// It never searches for people. It writes to nobody without a real detail seen on their own professional
// profile and the place that detail came from, skips anyone who opted out, sends one follow-up, and stops at 20 a day.
// No message states a price: the preview link shows the price that applies (src/offer.ts).
import type { TemplateId } from './domain.ts';
import { brandParam, CUSTOM_SLUG, demoQuery } from './demoBrand.ts';
import { TEMPLATES } from './theme.ts';

export const DAILY_LIMIT = 20;
export const DEFAULT_BASE = 'https://pt-app-codebase.netlify.app';
const FOLLOW_UP_DAYS = 6;
/** The demo link refuses a brand name longer than this (src/demoBrand.ts), so the preview would not load. */
const MAX_BRAND_NAME = 40;
/** International numbers run from about 10 digits with the country code to 15 (E.164). */
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STOPPED = new Set(['replied', 'closed', 'declined', 'followed_up']);
const YES = new Set(['y', 'yes', 's', 'si', 'sì', 'true', '1', 'x']);

/** One tracker row, every cell as typed. Columns: see COLUMNS. */
export interface TrackerRow {
  tier: string;
  score: string;
  name: string;
  town: string;
  type: string;
  studio: string;
  style: string;
  instagram: string;
  businessPhone: string;
  businessEmail: string;
  sourceUrl: string;
  detailSeen: string;
  channel: string;
  firstContact: string;
  followUpDue: string;
  status: string;
  optedOut: string;
}

const COLUMNS: Record<keyof TrackerRow, string> = {
  tier: 'tier', score: 'score', name: 'name', town: 'town', type: 'type', studio: 'studio', style: 'style',
  instagram: 'instagram', businessPhone: 'business_phone', businessEmail: 'business_email', sourceUrl: 'source_url',
  detailSeen: 'detail_seen', channel: 'channel', firstContact: 'first_contact', followUpDue: 'follow_up_due',
  status: 'status', optedOut: 'opted_out',
};

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

export function readTracker(csv: string): TrackerRow[] {
  const [header = [], ...body] = parseCsv(csv);
  const names = header.map((h) => h.trim().toLowerCase());
  if (!names.includes('name') || !names.includes('tier')) throw new Error('The tracker needs at least the columns name and tier.');
  return body
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      const cell = (key: keyof TrackerRow) => (cells[names.indexOf(COLUMNS[key])] ?? '').trim();
      return {
        tier: cell('tier'), score: cell('score'), name: cell('name'), town: cell('town'), type: cell('type'),
        studio: cell('studio'), style: cell('style'), instagram: cell('instagram'), businessPhone: cell('businessPhone'),
        businessEmail: cell('businessEmail'), sourceUrl: cell('sourceUrl'), detailSeen: cell('detailSeen'),
        channel: cell('channel'), firstContact: cell('firstContact'), followUpDue: cell('followUpDue'),
        status: cell('status'), optedOut: cell('optedOut'),
      };
    });
}

/** The number as wa.me wants it: country code first, digits only. A number without one is taken as Italian. */
export function phoneDigits(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  return digits.startsWith('39') && digits.length >= 11 ? digits : `39${digits}`;
}

function instagramUrl(raw: string): string | null {
  const handle = raw.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0] ?? '';
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `https://instagram.com/${handle}` : null;
}

const isStudio = (r: TrackerRow) => r.type.trim().toLowerCase() === 'studio' && r.studio.trim() !== '';
const brandName = (r: TrackerRow) => (isStudio(r) ? r.studio.trim() : r.name.trim());
const styleOf = (r: TrackerRow): TemplateId => {
  const style = r.style.trim().toLowerCase();
  return Object.hasOwn(TEMPLATES, style) ? (style as TemplateId) : 'studio';
};

/** The personal preview: the demo with their name, their town and a look, on the plan that shows the shop. */
export function previewLink(r: TrackerRow, base: string = DEFAULT_BASE): string {
  const template = styleOf(r);
  const { brand, accent } = TEMPLATES[template].sample;
  const param = brandParam({
    name: brandName(r),
    tagline: r.town.trim() ? `Personal training a ${r.town.trim()}.` : '',
    template,
    plan: 'pro',
    theme: { brand, accent, mode: 'auto' },
  });
  return `${base.replace(/\/$/, '')}/${demoQuery(CUSTOM_SLUG, param)}`;
}

const firstName = (r: TrackerRow) => r.name.trim().split(/\s+/)[0] ?? r.name.trim();
const phrase = (s: string) => s.trim().replace(/[.\s]+$/, '');

function firstMessage(r: TrackerRow, link: string, channel: 'instagram' | 'whatsapp', privacyUrl: string | undefined): string {
  const detail = phrase(r.detailSeen);
  const whatsapp = channel === 'whatsapp';
  const lines = isStudio(r)
    ? [
        `Buongiorno ${firstName(r)}, sono Manuel di Punto Due Studio. Ho visto ${r.studio.trim()} e mi ha colpito ${detail}.`,
        `Creiamo app con il brand dello studio dove i clienti prenotano, vedono i pacchetti e invitano gli amici. Ho preparato un'anteprima con il vostro nome: ${link}`,
        'Se può interessarvi, mi dice quando passare 15 minuti. Altrimenti nessun problema, non vi ricontatto.',
      ]
    : whatsapp
      ? [
          `Buongiorno ${firstName(r)}, sono Manuel di Punto Due Studio. Ti scrivo al numero che indichi per il tuo lavoro. Ho visto ${detail}.`,
          `Facciamo app per personal trainer con il tuo nome e i tuoi colori: prenotazioni, pacchetti, lista d'attesa. Qui c'è un'anteprima pensata per te: ${link}`,
          'Se non ti interessa dimmelo e non ti scrivo più.',
        ]
      : [
          `Ciao ${firstName(r)}, sono Manuel di Punto Due Studio. Ho visto ${detail}.`,
          `Realizziamo app per personal trainer con il nome e i colori di ciascuno. Ti ho preparato un'anteprima di come potrebbe essere la tua: ${link}`,
          'Non ti chiedo nulla adesso. Se ti incuriosisce scrivimi, se no ignora pure il messaggio e non ti disturbo più.',
        ];
  return (whatsapp && privacyUrl ? [...lines, `Informativa: ${privacyUrl}`] : lines).join('\n');
}

const followUpMessage = (r: TrackerRow, link: string): string =>
  [
    `Ciao ${firstName(r)}, ti riscrivo una volta sola: sei riuscito a vedere l'anteprima? Se non è il momento nessun problema, non ti scrivo più.`,
    `L'anteprima è qui: ${link}`,
  ].join('\n');

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface Outreach {
  name: string;
  town: string;
  tier: string;
  channel: 'instagram' | 'whatsapp';
  kind: 'first' | 'follow-up';
  /** Their profile (Instagram) or their business number (WhatsApp). */
  target: string;
  link: string;
  message: string;
  /** WhatsApp only: opens the chat with the message already typed. You still press send. */
  send?: string;
}
export interface Skip {
  name: string;
  reason: string;
}
export interface Plan {
  ready: Outreach[];
  skipped: Skip[];
}
export interface PlanOptions {
  /** YYYY-MM-DD. */
  today: string;
  base?: string;
  privacyUrl?: string;
  limit?: number;
}

/** One row: the message to send today, or the reason there is none. */
function evaluate(r: TrackerRow, o: PlanOptions): Outreach | string {
  if (YES.has(r.optedOut.trim().toLowerCase())) return 'opted out';
  const tier = r.tier.trim().toUpperCase();
  if (tier !== 'A' && tier !== 'B') return 'tier C or missing: not contacted';
  const status = r.status.trim().toLowerCase();
  if (STOPPED.has(status)) return `status ${status}`;
  if (r.name.trim() === '') return 'no name';
  if (brandName(r).length > MAX_BRAND_NAME) return `name longer than ${MAX_BRAND_NAME} characters, the preview would not load`;

  const sent = r.firstContact.trim();
  if (sent) {
    if (!ISO_DATE.test(sent)) return 'first_contact must be YYYY-MM-DD';
    const due = r.followUpDue.trim() || addDays(sent, FOLLOW_UP_DAYS);
    if (due > o.today) return `follow-up due ${due}`;
  } else {
    if (!r.detailSeen.trim()) return 'no detail_seen: a message without a real detail is spam';
    if (!r.sourceUrl.trim()) return 'no source_url: note where you found them';
  }

  const channel = r.channel.trim().toLowerCase() || (r.instagram.trim() ? 'instagram' : '');
  let target: string;
  if (channel === 'instagram') {
    const url = instagramUrl(r.instagram);
    if (!url) return 'no instagram handle';
    target = url;
  } else if (channel === 'whatsapp') {
    if (!r.businessPhone.trim()) return 'no business_phone';
    const digits = phoneDigits(r.businessPhone);
    if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return 'business_phone is not a valid number';
    if (!o.privacyUrl && !sent) return 'no privacy link: pass --privacy';
    target = `+${digits}`;
  } else return channel === '' ? 'no channel (instagram or whatsapp)' : `channel "${channel}" is not supported (instagram or whatsapp)`;

  const link = previewLink(r, o.base);
  const message = sent ? followUpMessage(r, link) : firstMessage(r, link, channel, o.privacyUrl);
  return {
    name: r.name.trim(),
    town: r.town.trim(),
    tier,
    channel,
    kind: sent ? 'follow-up' : 'first',
    target,
    link,
    message,
    send: channel === 'whatsapp' ? `https://wa.me/${phoneDigits(r.businessPhone)}?text=${encodeURIComponent(message)}` : undefined,
  };
}

/** Today's messages: strongest tier and score first, at most the daily limit, everything else with its reason. */
export function planOutreach(rows: readonly TrackerRow[], o: PlanOptions): Plan {
  const limit = o.limit ?? DAILY_LIMIT;
  const results = rows.map((r) => ({ r, out: evaluate(r, o) }));
  const skipped = results.flatMap(({ r, out }) => (typeof out === 'string' ? [{ name: r.name.trim(), reason: out }] : []));
  const eligible = results
    .flatMap(({ r, out }) => (typeof out === 'string' ? [] : [{ out, score: Number(r.score) || 0 }]))
    .toSorted((a, b) => a.out.tier.localeCompare(b.out.tier) || b.score - a.score || a.out.name.localeCompare(b.out.name));
  return {
    ready: eligible.slice(0, limit).map((e) => e.out),
    skipped: [...skipped, ...eligible.slice(limit).map((e) => ({ name: e.out.name, reason: `over the daily limit (${limit})` }))],
  };
}

export function renderReport(plan: Plan, today: string): string {
  const head = `# Outreach for ${today}: ${plan.ready.length} ready, ${plan.skipped.length} skipped`;
  const items = plan.ready.map((m, i) =>
    [
      `## ${i + 1}. ${m.tier} · ${m.name} · ${m.town || 'no town'} · ${m.channel}${m.kind === 'follow-up' ? ' · follow-up' : ''}`,
      `Open: ${m.target}`,
      ...(m.send ? [`Send: ${m.send}`] : []),
      `Preview: ${m.link}`,
      '',
      ...m.message.split('\n').map((line) => `> ${line}`),
    ].join('\n'),
  );
  const skipped = plan.skipped.length ? ['## Skipped', ...plan.skipped.map((s) => `- ${s.name}: ${s.reason}`)].join('\n') : '';
  const after = 'After you send: put the date in first_contact and "contacted" in status. If someone says no, put Y in opted_out and never write again.';
  return [head, ...items, skipped, after].filter(Boolean).join('\n\n') + '\n';
}
