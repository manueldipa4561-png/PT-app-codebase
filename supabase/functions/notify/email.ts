// The text of the alerts. Pure, so the same file runs in the Edge Function (Deno) and in the tests (Node). It must
// not import from src/: the function is deployed on its own, with only the files in this folder.

/** One alert as public.claim_notifications() hands it out: everything the email needs. */
export interface Alert {
  id: string;
  kind: 'waitlist_open';
  to_email: string;
  to_name: string;
  trainer_name: string;
  reply_to: string | null;
  locale: string;
  timezone: string;
  session_name: string;
  starts_at: string;
  location: string | null;
  app_url: string | null;
  from_address: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const TEXT = {
  it: {
    subject: (when: string) => `Si è liberato un posto: ${when}`,
    hello: (name: string) => (name ? `Ciao ${name},` : 'Ciao,'),
    body: (session: string, when: string, place: string) => `si è liberato un posto per ${session}, ${when}${place}.`,
    first: 'Lo ha chi prenota per primo.',
    cta: 'Prenota ora',
    open: (trainer: string) => `Apri l’app di ${trainer} e prenota.`,
    why: (trainer: string) => `Ricevi questo messaggio perché sei in lista d’attesa da ${trainer}. Per non riceverne più per questo orario, esci dalla lista nell’app (Agenda).`,
    at: 'alle',
    in: 'a',
  },
  en: {
    subject: (when: string) => `A place opened up: ${when}`,
    hello: (name: string) => (name ? `Hi ${name},` : 'Hi,'),
    body: (session: string, when: string, place: string) => `a place has opened up for ${session}, ${when}${place}.`,
    first: 'First to book gets it.',
    cta: 'Book now',
    open: (trainer: string) => `Open ${trainer}’s app and book.`,
    why: (trainer: string) => `You are getting this because you are on ${trainer}’s waitlist. To stop hearing about this time, leave the list in the app (Agenda).`,
    at: 'at',
    in: 'at',
  },
} as const;

const NEWLINE = String.fromCharCode(10);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** One line, no control characters: whatever a trainer typed in a name stays out of the headers. */
export const oneLine = (s: string) =>
  Array.from(s, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').split(' ').filter(Boolean).join(' ');

/** "giovedì 8 ottobre alle 18:30", in the trainer's own time zone. */
export function when(iso: string, timezone: string, lang: 'it' | 'en'): string {
  const locale = lang === 'it' ? 'it-IT' : 'en-GB';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${day} ${TEXT[lang].at} ${time}`;
}

export function render(a: Alert): Rendered {
  const lang = a.locale === 'en' ? 'en' : 'it';
  const t = TEXT[lang];
  const trainer = oneLine(a.trainer_name);
  const name = oneLine(a.to_name).split(' ')[0] ?? '';
  const slot = when(a.starts_at, a.timezone, lang);
  const place = a.location ? ` (${oneLine(a.location)})` : '';
  const session = oneLine(a.session_name);
  const link = a.app_url?.startsWith('https://') ? a.app_url : null;

  const subject = t.subject(slot);
  const lines = [t.hello(name), '', t.body(session, slot, place), t.first, '', link ? `${t.cta}: ${link}` : t.open(trainer), '', t.why(trainer), '', `— ${trainer}`];

  const button = link
    ? `<p style="margin:26px 0"><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:12px">${esc(t.cta)}</a></p>`
    : `<p style="margin:22px 0">${esc(t.open(trainer))}</p>`;
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111">` +
    `<div style="display:none;max-height:0;overflow:hidden">${esc(t.first)}</div>` +
    `<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;line-height:1.5;font-size:16px">` +
    `<p style="margin:0 0 14px">${esc(t.hello(name))}</p>` +
    `<p style="margin:0 0 6px">${esc(t.body(session, slot, place))}</p>` +
    `<p style="margin:0;font-weight:600">${esc(t.first)}</p>` +
    button +
    `<p style="margin:0 0 14px;color:#6b7280;font-size:13px">${esc(t.why(trainer))}</p>` +
    `<p style="margin:0">— ${esc(trainer)}</p>` +
    `</div></body></html>`;
  return { subject, html, text: lines.join(NEWLINE) };
}
