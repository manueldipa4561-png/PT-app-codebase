import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarPlus, CalendarX, ChatCircleText, Check } from '@phosphor-icons/react';
import { AppError, addDays, firstName, localParts, weeklyRepeats, whatsappLink, type Booking, type Slot } from '../domain.ts';
import { counted, errorText, fmtDay, fmtLongDay, fmtTime, useI18n } from '../i18n.ts';
import { Button, Empty, ErrorState, Segmented, Sheet, Skeleton, haptic, useApp } from '../ui.tsx';
import { calendarLinks } from './Home.tsx';

const DAYS = 14;
const DAY_MS = 86_400_000;
const codeOf = (e: unknown) => (e instanceof AppError ? e.code : 'generic');

// The Agenda's "Sposta" sets this before opening Book, which reads it once: the session being moved.
let moving: Booking | null = null;
export function startMove(b: Booking) {
  moving = b;
}

/** What booking a standing weekly slot gave: the sessions booked, and the weeks that could not be. */
interface Series {
  booked: Booking[];
  skipped: { startsAt: string; code: string }[];
}

export function Book() {
  const { api, trainer, types, balance, refresh, toast } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const coach = firstName(trainer.name);
  const [move] = useState<Booking | null>(() => {
    const m = moving;
    moving = null;
    return m;
  });
  const [typeId, setTypeId] = useState(move?.sessionTypeId ?? types[0]?.id);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<Slot | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Series | null>(null);
  const [weeks, setWeeks] = useState(1);

  const today = localParts(Date.now(), tz).date;
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i)), [today]);
  const type = types.find((x) => x.id === typeId);
  // moving a session gives its credit back first, so it needs none of its own
  const noCredits = !move && (type?.credits ?? 0) > balance;
  // a standing weekly slot: 2 or 4 weeks, as far as the credits and the booking horizon reach
  const weekOptions =
    pick && !move && type
      ? [1, 2, 4].filter((n) => (type.credits > 0 ? n * type.credits <= balance : true) && Date.parse(pick.startsAt) + (n - 1) * 7 * DAY_MS <= Date.now() + trainer.bookingHorizonDays * DAY_MS)
      : [1];

  // Switching session type quickly: only the latest request may fill the slots.
  const request = useRef(0);
  const load = useCallback(async () => {
    if (!typeId) return;
    const mine = ++request.current;
    setSlots(null);
    setError(null);
    try {
      const found = await api.freeSlots(typeId, today, DAYS);
      if (mine === request.current) setSlots(found);
    } catch (e) {
      if (mine === request.current) setError(codeOf(e));
    }
  }, [api, typeId, today]);

  useEffect(() => {
    setPick(null);
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots ?? []) {
      const d = localParts(Date.parse(s.startsAt), tz).date;
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  // The picked day, or the first day with free slots once they load.
  const activeDay = day && byDay.has(day) ? day : slots ? (days.find((d) => byDay.has(d)) ?? days[0]) : null;

  async function confirm() {
    if (!pick || !typeId) return;
    setBusy(true);
    try {
      const first = move ? await api.reschedule(move.id, pick.startsAt) : await api.book(typeId, pick.startsAt);
      const series: Series = { booked: [first], skipped: [] };
      // a standing weekly slot: the same time in the weeks after; a full week is skipped, no credits stops it
      for (const at of weeks > 1 ? weeklyRepeats(pick.startsAt, weeks, tz) : []) {
        try {
          series.booked.push(await api.book(typeId, at));
        } catch (e) {
          const c = codeOf(e);
          series.skipped.push({ startsAt: at, code: c });
          if (c === 'NO_CREDITS') break;
        }
      }
      haptic(18);
      setConfirming(false);
      setDone(series);
      await refresh();
    } catch (e) {
      const c = codeOf(e);
      toast(errorText(t, c), 'error');
      setConfirming(false);
      setPick(null);
      if (c === 'SLOT_TAKEN' || c === 'TOO_SOON' || c === 'OUTSIDE_HOURS' || c === 'TOO_FAR') await load();
      else await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Success series={done} typeName={type?.name ?? ''} moved={!!move} />;

  const weekday = (d: string) => new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const daySlots = (activeDay && byDay.get(activeDay)) || [];

  return (
    <>
      <h1 className="page-title display">{t(move ? 'book.moveTitle' : 'book.title')}</h1>
      {move ? (
        <section className="pad section">
          <div className="card card-soft">
            <p style={{ margin: 0 }}>
              {t('book.moveBanner', { what: `${type?.name ?? ''}, ${fmtLongDay(move.startsAt, tz, lang)}, ${fmtTime(move.startsAt, tz, lang)}` })}
            </p>
          </div>
        </section>
      ) : (
        <section className="pad section">
          <h2 className="section-title">{t('book.type')}</h2>
          <div className="types">
            {types.map((ty) => (
              <button key={ty.id} className="type-card" aria-pressed={ty.id === typeId} onClick={() => setTypeId(ty.id)}>
                <span className="type-name">{ty.name}</span>
                <span className="type-meta">{t('book.min', { n: ty.minutes })}</span>
                {ty.description && <span className="type-desc">{ty.description}</span>}
                <span className="type-desc">
                  {ty.credits === 0 ? t('book.free') : counted(t, lang, 'sessions', ty.credits)}
                  {ty.capacity > 1 ? `, ${t('book.upTo', { n: ty.capacity }).toLowerCase()}` : ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {noCredits && (
        <div className="pad section">
          <div className="card card-soft">
            <p style={{ margin: '0 0 12px' }}>{t('book.noCredits', { trainer: coach })}</p>
            <a className="btn btn-primary" href={whatsappLink(trainer.whatsapp, t('home.askPackMsg', { trainer: coach }))} target="_blank" rel="noreferrer">
              <ChatCircleText size={18} aria-hidden /> {t('home.askPack')}
            </a>
          </div>
        </div>
      )}

      <section className="pad section">
        <h2 className="section-title">{t('book.day')}</h2>
        <div className="days">
          {days.map((d) => {
            const has = byDay.has(d);
            return (
              <button
                key={d}
                className="day"
                aria-pressed={d === activeDay}
                disabled={!slots || !has}
                onClick={() => {
                  setDay(d);
                  setPick(null);
                }}
              >
                <span className="day-wd">{weekday(d)}</span>
                <span className="day-n">{Number(d.slice(8))}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pad section">
        <h2 className="section-title">{t('book.time')}</h2>
        {error ? (
          <ErrorState text={errorText(t, error)} onRetry={load} />
        ) : !slots ? (
          <div className="slots">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} h={52} r={14} />
            ))}
          </div>
        ) : daySlots.length ? (
          <motion.div key={activeDay} className="slots" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.025 } } }}>
            {daySlots.map((s) => (
              <motion.button
                key={s.startsAt}
                className="slot"
                aria-pressed={pick?.startsAt === s.startsAt}
                variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
                onClick={() => setPick(s)}
              >
                <span>
                  {fmtTime(s.startsAt, tz, lang)}
                  {type && type.capacity > 1 && <small>{counted(t, lang, 'places', s.placesLeft)}</small>}
                </span>
              </motion.button>
            ))}
          </motion.div>
        ) : (
          <Empty icon={<CalendarX size={26} />} title={slots.length ? t('book.noDay') : t('book.noDays', { trainer: coach })} />
        )}
      </section>

      <AnimatePresence>
        {pick && (
          <motion.div className="sticky-cta" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
            <Button size="lg" block disabled={noCredits} onClick={() => setConfirming(true)}>
              {t('book.confirm')}: {fmtDay(pick.startsAt, tz, lang)}, {fmtTime(pick.startsAt, tz, lang)}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={confirming && !!pick} onClose={() => setConfirming(false)} title={t(move ? 'book.moveTitle' : 'book.confirmTitle')}>
        {pick && type && (
          <>
            <div className="summary">
              <div className="summary-row">
                <span>{t('book.session')}</span>
                <b>{type.name}</b>
              </div>
              <div className="summary-row">
                <span>{t(move ? 'book.moveTo' : 'book.day')}</span>
                <b>
                  {fmtLongDay(pick.startsAt, tz, lang)}, {fmtTime(pick.startsAt, tz, lang)}
                </b>
              </div>
              {pick.location && (
                <div className="summary-row">
                  <span>{t('book.where')}</span>
                  <b>{pick.location}</b>
                </div>
              )}
              {move && (
                <div className="summary-row">
                  <span>{t('book.moveNow')}</span>
                  <b>
                    {fmtLongDay(move.startsAt, tz, lang)}, {fmtTime(move.startsAt, tz, lang)}
                  </b>
                </div>
              )}
              <div className="summary-row">
                <span>{t('book.after')}</span>
                <b>{counted(t, lang, 'left', move ? balance : balance - type.credits * weeks)}</b>
              </div>
            </div>
            {weekOptions.length > 1 && (
              <div style={{ margin: '0 0 14px' }}>
                <p className="section-title" style={{ margin: '0 0 8px' }}>
                  {t('book.repeat')}
                </p>
                <Segmented<string>
                  id="repeat"
                  label={t('book.repeat')}
                  value={String(weeks)}
                  onChange={(v) => setWeeks(Number(v))}
                  options={weekOptions.map((n) => ({ value: String(n), label: n === 1 ? t('book.repeatOnce') : t('book.repeatWeeks', { n }) }))}
                />
                {weeks > 1 && <p className="policy">{t('book.repeatNote')}</p>}
              </div>
            )}
            <p className="policy">{move ? t('book.moveNote') : t('book.policy', { h: trainer.cancelWindowHours })}</p>
            <Button size="lg" block loading={busy} onClick={confirm}>
              {t('book.confirm')}
            </Button>
          </>
        )}
      </Sheet>
    </>
  );
}

function Success({ series, typeName, moved }: { series: Series; typeName: string; moved: boolean }) {
    const { trainer, navigate } = useApp();
    const { t, lang } = useI18n();
    const tz = trainer.timezone;
    const booking = series.booked[0];
    const cal = calendarLinks(booking, `${typeName} · ${trainer.name}`, tz);
    const pieces = Array.from({ length: 14 }, (_, i) => (i / 14) * Math.PI * 2);
    return (
      <div className="success">
        <div className="success-badge">
          <div className="burst" aria-hidden>
            {pieces.map((a, i) => (
              <motion.i
                key={i}
                initial={{ x: -4, y: -4, opacity: 1, scale: 1, rotate: 0 }}
                animate={{ x: Math.cos(a) * 96 - 4, y: Math.sin(a) * 96 - 4, opacity: 0, scale: 0.5, rotate: 180 }}
                transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
              />
            ))}
          </div>
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 16 }}>
            <Check size={52} weight="bold" aria-hidden />
          </motion.span>
        </div>
        <h2 className="display">{series.booked.length > 1 ? t('book.seriesTitle', { n: series.booked.length }) : t(moved ? 'book.movedTitle' : 'book.done')}</h2>
        <p>
          {t(moved ? 'book.movedBody' : 'book.doneBody', { when: `${fmtLongDay(booking.startsAt, tz, lang)}, ${fmtTime(booking.startsAt, tz, lang)}` })}
        </p>
        {(series.booked.length > 1 || series.skipped.length > 0) && (
          <ul className="series">
            {series.booked.map((b) => (
              <li key={b.id}>
                <Check size={14} weight="bold" aria-hidden /> {fmtLongDay(b.startsAt, tz, lang)}, {fmtTime(b.startsAt, tz, lang)}
              </li>
            ))}
            {series.skipped.map((s) => (
              <li key={s.startsAt} className="series-skipped">
                <CalendarX size={14} aria-hidden /> {fmtLongDay(s.startsAt, tz, lang)}: {s.code === 'NO_CREDITS' ? errorText(t, 'NO_CREDITS') : t('book.seriesSkipped')}
              </li>
            ))}
          </ul>
        )}
        <div className="card-actions" style={{ justifyContent: 'center' }}>
          <a className="btn btn-secondary" href={cal.ics} download="sessione.ics">
            <CalendarPlus size={18} aria-hidden /> {t('home.addCal')}
          </a>
          <a className="btn btn-secondary" href={cal.google} target="_blank" rel="noreferrer">
            Google
          </a>
        </div>
        <div style={{ marginTop: 16, width: '100%' }}>
          <Button size="lg" block onClick={() => navigate('/')}>
            {t('book.backHome')}
          </Button>
        </div>
      </div>
    );
}
