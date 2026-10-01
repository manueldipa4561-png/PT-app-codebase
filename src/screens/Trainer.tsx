import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion, animate } from 'motion/react';
import { ArrowUUpLeft, CalendarBlank, CaretLeft, CaretRight, DownloadSimple, MagnifyingGlass, Trash, UserPlus } from '@phosphor-icons/react';
import { AppError, PAY_METHODS, balanceOf, localParts, monthStats, zonedToUtc, type Booking, type Client, type PayMethod } from '../domain.ts';
import type { TrainerData } from '../api.ts';
import { counted, errorText, fmtDay, fmtMoney, fmtTime, useI18n, type Key } from '../i18n.ts';
import { InstallApp, isInstalled } from '../install.tsx';
import { FollowUps } from './FollowUps.tsx';
import { monthPayments, monthsBack, packRevenue, percentChange, weeklySessions } from '../stats.ts';
import { quietClients, renewals, upcomingReminders } from '../followups.ts';
import { Button, Empty, ErrorState, Field, Sheet, Skeleton, haptic, useApp, useLiveRefresh } from '../ui.tsx';

type Tab = 'today' | 'clients' | 'invites' | 'month' | 'blocks';
const codeOf = (e: unknown) => (e instanceof AppError ? e.code : 'generic');
const LIVE = new Set(['booked', 'attended', 'no_show']);

/** Spreadsheet-safe CSV: quotes everything and defuses formula injection (=, +, -, @). */
function csv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(';')).join('\r\n'); // semicolon: what Italian spreadsheets expect
}

/** Hands a CSV to the browser as a file. The BOM makes accents come out right when a spreadsheet opens it. */
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

export function Trainer() {
  const { api, trainer, types, toast } = useApp();
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<Tab>('today');
  const [data, setData] = useState<TrainerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openClient, setOpenClient] = useState<Client | null>(null); // kept after closing, so the sheet can animate out
  const [clientOpen, setClientOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const tz = trainer.timezone;

  const load = useCallback(async () => {
    try {
      setData(await api.trainerData(trainer.id));
      setError(null);
    } catch (e) {
      setError(codeOf(e));
    }
  }, [api, trainer.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // In the background a failed reload keeps what is on screen, instead of an error page.
  useLiveRefresh(() => api.trainerData(trainer.id).then(setData, () => {}));

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        haptic();
        if (ok) toast(ok);
        await load();
        return true;
      } catch (e) {
        toast(errorText(t, codeOf(e)), 'error');
        return false;
      }
    },
    [load, t, toast],
  );

  const clientsById = useMemo(() => new Map((data?.clients ?? []).map((c) => [c.id, c])), [data]);
  const typeName = (id: string) => types.find((x) => x.id === id)?.name ?? '';

  function exportCsv() {
    if (!data) return;
    const rows = [['Nome', 'Email', 'Telefono', 'Sessioni rimaste', 'Cliente dal']];
    for (const c of data.clients.filter((x) => !x.deletedAt)) {
      rows.push([c.name, c.email ?? '', c.phone ?? '', String(balanceOf(data.ledger, c.id)), c.createdAt.slice(0, 10)]);
    }
    download(csv(rows), `clienti-${trainer.slug}.csv`);
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'today', label: t('tr.today') },
    { id: 'clients', label: t('tr.clients') },
    { id: 'invites', label: t('tr.invites') },
    { id: 'month', label: t('tr.month') },
    { id: 'blocks', label: t('tr.blocks') },
  ];

  return (
    <>
      <div className="row" style={{ padding: 'calc(20px + env(safe-area-inset-top)) 16px 0' }}>
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {trainer.name}
          </p>
          <h1 className="display" style={{ margin: 0, fontSize: 38 }}>
            {t('tr.title')}
          </h1>
        </div>
        <span className="spacer" />
        <Button variant="secondary" onClick={exportCsv} icon={<DownloadSimple size={18} aria-hidden />} aria-label={t('tr.export')} />
      </div>
      {!isInstalled() && (
        <div className="pad" style={{ marginTop: 16 }}>
          <InstallApp />
        </div>
      )}
      <div className="tabs-scroll" role="group" aria-label={t('tr.title')}>
        {tabs.map((x) => (
          <button key={x.id} type="button" className="chip" aria-pressed={tab === x.id} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>

      <section className="pad">
        {error ? (
          <ErrorState text={errorText(t, error)} onRetry={load} />
        ) : !data ? (
          <div className="stack">
            <Skeleton h={72} r={18} />
            <Skeleton h={72} r={18} />
            <Skeleton h={72} r={18} />
          </div>
        ) : tab === 'today' ? (
          <Today data={data} name={(id) => clientsById.get(id)?.name ?? ''} typeName={typeName} act={act} />
        ) : tab === 'clients' ? (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="input row" style={{ flex: 1, gap: 8 }}>
                <MagnifyingGlass size={18} aria-hidden />
                <input
                  aria-label={t('tr.search')}
                  placeholder={t('tr.search')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ border: 0, outline: 0, background: 'none', flex: 1, minWidth: 0 }}
                />
              </label>
              <Button onClick={() => setAdding(true)} icon={<UserPlus size={18} aria-hidden />} aria-label={t('tr.addClient')} />
            </div>
            <div className="list">
              {data.clients
                .filter((c) => !c.deletedAt && c.name.toLowerCase().includes(query.trim().toLowerCase()))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => {
                  const bal = balanceOf(data.ledger, c.id);
                  return (
                    <button
                      key={c.id}
                      className="item"
                      style={{ textAlign: 'left' }}
                      onClick={() => {
                        setOpenClient(c);
                        setClientOpen(true);
                      }}
                    >
                      <div className="item-main">
                        <div className="item-title">{c.name}</div>
                        <div className="item-sub">{c.userId ? c.email : t('tr.noLogin')}</div>
                      </div>
                      <span className={`badge${bal < 0 ? ' badge-warn' : bal <= 2 ? '' : ' badge-brand'}`}>
                        {bal < 0 ? `${counted(t, lang, 'sessions', -bal)} ${t('tr.owed')}` : counted(t, lang, 'left', bal)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </>
        ) : tab === 'invites' ? (
          data.referrals.length === 0 ? (
            <Empty icon={<UserPlus size={26} />} title={t('refer.none')} />
          ) : (
            <div className="list">
              {data.referrals
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((r) => (
                  <div key={r.id} className="item">
                    <div className="item-main">
                      <div className="item-title">{clientsById.get(r.referredClientId)?.name}</div>
                      <div className="item-sub">
                        {t('tr.invitedBy', { name: clientsById.get(r.referrerClientId)?.name ?? '', date: fmtDay(r.createdAt, tz, lang) })}
                      </div>
                    </div>
                    <span className={`badge${r.status === 'rewarded' ? ' badge-brand' : ''}`}>
                      {t(r.status === 'rewarded' ? 'tr.ref.rewarded' : r.status === 'reversed' ? 'refer.reversed' : 'tr.ref.pending')}
                    </span>
                    {r.status !== 'reversed' && (
                      <Button
                        variant="ghost"
                        aria-label={t('tr.reverse')}
                        icon={<ArrowUUpLeft size={18} aria-hidden />}
                        onClick={() => act(() => api.reverseReferral(r.id), t('tr.saved'))}
                      />
                    )}
                  </div>
                ))}
            </div>
          )
        ) : tab === 'month' ? (
          <Month data={data} />
        ) : (
          <Blocks data={data} act={act} />
        )}
      </section>

      {/* keyed by client: nothing typed for one client (price, credits, date) can carry over to the next */}
      <ClientSheet key={openClient?.id ?? 'none'} client={openClient} open={clientOpen} data={data} onClose={() => setClientOpen(false)} act={act} />
      <AddClient open={adding} onClose={() => setAdding(false)} act={act} />
    </>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function Today({ data, name, typeName, act }: { data: TrainerData; name(id: string): string; typeName(id: string): string; act: Act }) {
  const { api, trainer } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const now = Date.now();
  const today = localParts(now, tz).date;
  const dayOf = (b: Booking) => localParts(Date.parse(b.startsAt), tz).date;
  const live = data.bookings.filter((b) => LIVE.has(b.status)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const todays = live.filter((b) => dayOf(b) === today);
  const soon = live.filter((b) => dayOf(b) !== today && Date.parse(b.startsAt) > now && Date.parse(b.startsAt) < now + 7 * 86_400_000);

  const weekdayDay = new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { timeZone: tz, weekday: 'short', day: 'numeric' });
  const row = (b: Booking, withDay: boolean) => (
    <div key={b.id} className="item">
      <div className="item-date">
        <b className="tabular" style={{ fontSize: 18 }}>
          {fmtTime(b.startsAt, tz, lang)}
        </b>
        {withDay && <span>{weekdayDay.format(new Date(b.startsAt))}</span>}
      </div>
      <div className="item-main">
        <div className="item-title">{name(b.clientId)}</div>
        <div className="item-sub">
          {typeName(b.sessionTypeId)}
          {b.location ? `, ${b.location}` : ''}
        </div>
      </div>
      {b.status === 'booked' && Date.parse(b.startsAt) <= now ? (
        <div className="row" style={{ gap: 6 }}>
          <Button variant="secondary" onClick={() => act(() => api.setAttendance(b.id, 'attended'))}>
            {t('tr.attended')}
          </Button>
          <Button variant="ghost" onClick={() => act(() => api.setAttendance(b.id, 'no_show'))}>
            {t('tr.noShow')}
          </Button>
        </div>
      ) : b.status === 'booked' ? null : (
        <span className={`badge${b.status === 'attended' ? ' badge-brand' : b.status === 'no_show' ? ' badge-warn' : ''}`}>{t(`status.${b.status}` as Key)}</span>
      )}
    </div>
  );

  // The day at a glance: how many sessions, which one is next, and what is waiting to be done.
  const nextToday = todays.find((b) => Date.parse(b.startsAt) > now);
  const chips = [
    { n: upcomingReminders(data.bookings, data.clients, now).length, key: 'tr.sum.remind' as const },
    { n: renewals(data.clients, data.ledger).length, key: 'tr.sum.renew' as const },
    { n: quietClients(data.clients, data.bookings, data.ledger, now).length, key: 'tr.sum.quiet' as const },
  ].filter((c) => c.n > 0);

  return (
    <div className="stack">
      <article className="card card-brand today-sum">
        <p className="card-eyebrow muted">
          {new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now))}
        </p>
        <p className="next-when display">{todays.length ? t('tr.sum.sessions', { n: counted(t, lang, 'sessions', todays.length) }) : t('tr.sum.none')}</p>
        {todays.length > 0 && (
          <p className="today-next">{nextToday ? t('tr.sum.next', { time: fmtTime(nextToday.startsAt, tz, lang), name: name(nextToday.clientId) }) : t('tr.sum.done')}</p>
        )}
        {chips.length > 0 && (
          <div className="sum-chips">
            {chips.map((c) => (
              <span key={c.key} className="sum-chip">
                {t(c.key, { n: c.n })}
              </span>
            ))}
          </div>
        )}
      </article>
      {todays.length ? <div className="list">{todays.map((b) => row(b, false))}</div> : <Empty icon={<CalendarBlank size={26} />} title={t('tr.todayEmpty')} />}
      <FollowUps data={data} />
      <h2 className="section-title" style={{ marginTop: 16 }}>
        {t('tr.next')}
      </h2>
      <div className="list">{soon.map((b) => row(b, true))}</div>
    </div>
  );
}

function CountUp({ value, format }: { value: number; format(v: number): string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = format(value);
      return;
    }
    const ctl = animate(0, value, { duration: 1, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => (el.textContent = format(v)) });
    return () => ctl.stop();
  }, [value, reduce, format]);
  return <span ref={ref}>{format(value)}</span>;
}

/** Sessions per week over the last 8 weeks: the rhythm of the business at a glance. */
function WeeklyBars({ data }: { data: TrainerData }) {
  const { trainer } = useApp();
  const { t, lang } = useI18n();
  const weeks = weeklySessions(data.bookings, Date.now(), trainer.timezone);
  const max = Math.max(1, ...weeks.map((w) => w.sessions));
  const label = new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const when = (start: string) => label.format(new Date(`${start}T12:00:00Z`));
  return (
    <article className="card weeks">
      <p className="card-eyebrow muted">{t('tr.m.weeks')}</p>
      <div className="bars" role="img" aria-label={weeks.map((w) => `${when(w.start)}: ${w.sessions}`).join(', ')}>
        {weeks.map((w) => (
          <div key={w.start} className={`bar${w.current ? ' bar-now' : ''}`}>
            <span className="bar-n tabular">{w.sessions}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ height: `${Math.max(4, (w.sessions / max) * 100)}%` }} />
            </span>
            <span className="bar-l">{when(w.start)}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function Month({ data }: { data: TrainerData }) {
  const { trainer } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const [back, setBack] = useState(0); // 0 is this month; the accountant asks for the one before
  const now = Date.now();
  const at = monthsBack(now, back, tz);
  const s = monthStats(data, at, tz);
  const locale = lang === 'it' ? 'it-IT' : 'en-GB';
  const monthName = (ms: number) => new Intl.DateTimeFormat(locale, { timeZone: tz, month: 'long' }).format(new Date(ms));
  const month = new Intl.DateTimeFormat(locale, { timeZone: tz, month: 'long', year: 'numeric' }).format(new Date(at));
  // This month so far is compared with the same days of the month before; a finished month with the one before it.
  const day = back === 0 ? Number(localParts(now, tz).date.slice(8)) : null;
  const previous = monthsBack(now, back + 1, tz);
  const revenueChange = day !== null && day < 7 ? null : percentChange(s.packRevenueCents, packRevenue(data.packs, previous, tz, day));

  function exportPayments() {
    const method = (m: string) => t(`method.${m}` as Key);
    const rows: (string | number | null)[][] = [t('tr.m.csvHead').split(';')];
    for (const p of monthPayments(data.packs, data.clients, at, tz)) {
      rows.push([p.date, p.client, p.credits, p.amountCents === null ? '' : (p.amountCents / 100).toFixed(2).replace('.', ','), method(p.method), t(p.voided ? 'tr.m.csvVoid' : 'tr.m.csvOk')]);
    }
    download(csv(rows), `incassi-${trainer.slug}-${localParts(at, tz).date.slice(0, 7)}.csv`);
  }
  const whole = useCallback((v: number) => String(Math.round(v)), []);
  const money = useCallback((v: number) => fmtMoney(Math.round(v), trainer.currency, lang, true), [trainer.currency, lang]);
  const pct = useCallback((v: number) => `${Math.round(v)}%`, []);
  const tiles: { label: Key; value: number; format(v: number): string }[] = [
    { label: 'tr.m.opens', value: s.opens, format: whole },
    { label: 'tr.m.installed', value: Math.round((s.installedShare ?? 0) * 100), format: pct },
    { label: 'tr.m.sessions', value: s.sessionsDone, format: whole },
    ...(back === 0 ? [{ label: 'tr.m.upcoming' as const, value: s.upcoming, format: whole }] : [{ label: 'tr.m.noShow' as const, value: s.noShows, format: whole }]),
    { label: 'tr.m.self', value: Math.round((s.selfBookedShare ?? 0) * 100), format: pct },
    { label: 'tr.m.newClients', value: s.newClients, format: whole },
    { label: 'tr.m.referral', value: s.viaReferral, format: whole },
    { label: 'tr.m.late', value: s.lateCancels, format: whole },
  ];
  return (
    <>
      <div className="month-nav">
        <button className="icon-btn" onClick={() => setBack((b) => Math.min(3, b + 1))} disabled={back >= 3} aria-label={t('tr.m.prev')}>
          <CaretLeft size={20} aria-hidden />
        </button>
        <h2 className="section-title month-title">{month}</h2>
        <button className="icon-btn" onClick={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} aria-label={t('tr.m.next')}>
          <CaretRight size={20} aria-hidden />
        </button>
      </div>
      <motion.div key={back} className="stats" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05 } } }}>
        <motion.div className="stat stat-wide" variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}>
          <div className="stat-value display tabular">
            <CountUp value={s.packRevenueCents} format={money} />
          </div>
          <div className="stat-label">{t('tr.m.revenue')}</div>
          {revenueChange !== null && (
            <div className="stat-delta">
              {revenueChange >= 0 ? '+' : '−'}
              {Math.abs(revenueChange)}% {t(back === 0 ? 'tr.m.vsSame' : 'tr.m.vs', { month: monthName(previous) })}
            </div>
          )}
        </motion.div>
        {tiles.map((x) => (
          <motion.div key={x.label} className="stat" variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}>
            <div className="stat-value display tabular">
              <CountUp value={x.value} format={x.format} />
            </div>
            <div className="stat-label">{t(x.label)}</div>
          </motion.div>
        ))}
      </motion.div>
      <div className="stack" style={{ marginTop: 14 }}>
        <WeeklyBars data={data} />
        <Button variant="secondary" block onClick={exportPayments} icon={<DownloadSimple size={18} aria-hidden />}>
          {t('tr.m.export')}
        </Button>
        <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
          {t('tr.m.exportBody')}
        </p>
      </div>
    </>
  );
}

function Blocks({ data, act }: { data: TrainerData; act: Act }) {
  const { api, trainer } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const [date, setDate] = useState(localParts(Date.now(), tz).date);
  const [from, setFrom] = useState('12:00');
  const [to, setTo] = useState('14:00');
  const [note, setNote] = useState('');
  const [conflicts, setConflicts] = useState<Booking[]>([]);
  const upcoming = data.timeOff.filter((o) => Date.parse(o.endsAt) > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  async function add() {
    const s = zonedToUtc(date, from, tz);
    const e = zonedToUtc(date, to, tz);
    if (s === null || e === null || e <= s) return;
    const ok = await act(() => api.addTimeOff(trainer.id, new Date(s).toISOString(), new Date(e).toISOString(), note), t('tr.saved'));
    if (ok) setConflicts(data.bookings.filter((b) => b.status === 'booked' && Date.parse(b.startsAt) < e && Date.parse(b.endsAt) > s));
  }

  return (
    <div className="stack">
      <div className="card stack">
        <p className="card-title display" style={{ fontSize: 20 }}>
          {t('tr.block')}
        </p>
        <Field label={t('tr.date')}>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('tr.start')}>
            <input className="input" type="time" step={900} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('tr.end')}>
            <input className="input" type="time" step={900} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Field label={t('tr.blockNote')}>
          <input className="input" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button onClick={add}>{t('common.save')}</Button>
      </div>
      {upcoming.length === 0 ? (
        <p className="muted">{t('tr.blocksEmpty')}</p>
      ) : (
        <div className="list">
          {upcoming.map((o) => (
            <div key={o.id} className="item">
              <div className="item-main">
                <div className="item-title">
                  {fmtDay(o.startsAt, tz, lang)}, {fmtTime(o.startsAt, tz, lang)} - {fmtTime(o.endsAt, tz, lang)}
                </div>
                {o.note && <div className="item-sub">{o.note}</div>}
              </div>
              <Button variant="ghost" aria-label={t('common.cancel')} icon={<Trash size={18} aria-hidden />} onClick={() => act(() => api.removeTimeOff(o.id))} />
            </div>
          ))}
        </div>
      )}
      <Sheet open={conflicts.length > 0} onClose={() => setConflicts([])} title={t('tr.block')}>
        <p style={{ marginTop: 0 }}>{t('tr.conflicts', { n: conflicts.length })}</p>
        <div className="grid-2">
          <Button variant="secondary" onClick={() => setConflicts([])}>
            {t('agenda.keep')}
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              const ids = conflicts.map((b) => b.id);
              setConflicts([]);
              await act(async () => {
                for (const id of ids) await api.cancel(id);
              }, t('tr.saved'));
            }}
          >
            {t('tr.cancelAll')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ClientSheet({ client, open, data, onClose, act }: { client: Client | null; open: boolean; data: TrainerData | null; onClose(): void; act: Act }) {
  const { api, trainer, types, toast } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const [credits, setCredits] = useState(10);
  const [price, setPrice] = useState('');
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [delta, setDelta] = useState('');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [day, setDay] = useState(localParts(Date.now(), tz).date);
  const [time, setTime] = useState('18:00');
  const [busy, setBusy] = useState(false);
  // One operation id per intended action: a double tap or a network retry reuses it.
  const packOp = useRef(crypto.randomUUID());
  const adjustOp = useRef(crypto.randomUUID());
  if (!client || !data) return null;
  const bal = balanceOf(data.ledger, client.id);

  async function paid() {
    if (!client) return;
    setBusy(true);
    try {
      const cents = price.trim() ? Math.round(Number(price.replace(',', '.')) * 100) : null;
      const r = await api.markPackPaid(client.id, { credits, priceCents: Number.isFinite(cents) ? cents : null, method, opId: packOp.current });
      packOp.current = crypto.randomUUID();
      haptic(18);
      toast(r.rewarded ? t('tr.rewardToast') : t('tr.packToast'));
      setPrice('');
      await act(async () => {});
    } catch (e) {
      toast(errorText(t, codeOf(e)), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={client.name}>
      <div className="stack">
        <div className="card card-brand row">
          <span className="display tabular" style={{ fontSize: 48, lineHeight: 1 }}>
            {bal}
          </span>
          <span>{bal < 0 ? t('tr.owed') : counted(t, lang, 'left', bal).replace(/^\S+\s/, '')}</span>
        </div>

        <p className="card-title display" style={{ fontSize: 20, marginTop: 8 }}>
          {t('tr.packPaid')}
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {[5, 10, 20].map((n) => (
            <button key={n} className="chip" aria-pressed={credits === n} onClick={() => setCredits(n)}>
              {counted(t, lang, 'sessions', n)}
            </button>
          ))}
        </div>
        <div className="grid-2">
          <Field label={t('tr.price')}>
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="420" />
          </Field>
          <Field label={t('tr.method')}>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
              {PAY_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`method.${m}` as Key)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button loading={busy} onClick={paid}>
          {t('tr.register')}
        </Button>

        <p className="card-title display" style={{ fontSize: 20, marginTop: 12 }}>
          {t('tr.bookFor', { name: client.name.split(' ')[0] })}
        </p>
        <Field label={t('tr.type')}>
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((ty) => (
              <option key={ty.id} value={ty.id}>
                {ty.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label={t('tr.date')}>
            <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={t('tr.start')}>
            <input className="input" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            const start = zonedToUtc(day, time, tz);
            if (start !== null) void act(() => api.bookFor(client.id, typeId, new Date(start).toISOString()), t('tr.saved'));
          }}
        >
          {t('book.confirm')}
        </Button>

        <p className="card-title display" style={{ fontSize: 20, marginTop: 12 }}>
          {t('tr.adjust')}
        </p>
        <Field label={t('tr.credits')} hint={t('tr.adjustHint')}>
          <input className="input" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ''))} />
        </Field>
        <Button
          variant="secondary"
          onClick={async () => {
            const n = Number(delta);
            if (!Number.isInteger(n) || n === 0) return;
            if (await act(() => api.adjustCredits(client.id, n, t('ledger.manual'), adjustOp.current), t('tr.saved'))) {
              adjustOp.current = crypto.randomUUID();
              setDelta('');
            }
          }}
        >
          {t('common.save')}
        </Button>

        <h3 className="section-title" style={{ marginTop: 16 }}>
          {t('profile.history')}
        </h3>
        <div className="list">
          {data.ledger
            .filter((l) => l.clientId === client.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 8)
            .map((l) => (
              <div key={l.id} className="item">
                <div className="item-main">
                  <div className="item-title">{t(`ledger.${l.reason}` as Key)}</div>
                  <div className="item-sub">{fmtDay(l.createdAt, tz, lang)}</div>
                </div>
                <span className="badge tabular">
                  {l.delta > 0 ? '+' : ''}
                  {l.delta}
                </span>
              </div>
            ))}
        </div>
      </div>
    </Sheet>
  );
}

function AddClient({ open, onClose, act }: { open: boolean; onClose(): void; act: Act }) {
  const { api, trainer } = useApp();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <Sheet open={open} onClose={onClose} title={t('tr.addClient')}>
      <div className="stack">
        <Field label={t('tr.name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('join.email')}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('join.phone')}>
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Button
          disabled={!name.trim()}
          onClick={async () => {
            if (await act(() => api.addClient(trainer.id, { name, email: email || undefined, phone: phone || undefined }), t('tr.saved'))) {
              setName('');
              setEmail('');
              setPhone('');
              onClose();
            }
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}
