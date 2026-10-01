import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarPlus, CalendarX, ChatCircleText, Check } from '@phosphor-icons/react';
import { AppError, addDays, firstName, localParts, weeklyRepeats, whatsappLink, type Booking, type Slot, type WaitlistEntry } from '../domain.ts';
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

/** A time on the grid: free to book, or full and open to a waitlist. */
type Offered = Slot & { full: boolean };

/** What booking a standing weekly slot gave: the sessions booked, and the weeks that could not be. */
interface Series {
  booked: Booking[];
  skipped: { startsAt: string; code: string }[];
}

export function Book() {
  const { api, trainer, types, balance, waitlist, refresh, toast } = useApp();
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
  const [full, setFull] = useState<Slot[]>([]);
  const [waitFor, setWaitFor] = useState<Slot | null>(null);
  const [waitBusy, setWaitBusy] = useState(false);
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
    setFull([]);
    setError(null);
    try {
      const [free, taken] = await Promise.all([
        api.freeSlots(typeId, today, DAYS),
        // the waitlist is the extra: if the full times cannot be read, booking the free ones still works. Moving has no waitlist.
        move
          ? Promise.resolve<Slot[]>([])
          : api.fullSlots(typeId, today, DAYS).catch((e: unknown) => {
              console.warn('full times unavailable', e);
              return [] as Slot[];
            }),
      ]);
      if (mine === request.current) {
        setSlots(free);
        setFull(taken);
      }
    } catch (e) {
      if (mine === request.current) setError(codeOf(e));
    }
  }, [api, typeId, today, move]);

  useEffect(() => {
    setPick(null);
    void load();
  }, [load]);

  // free and full times together, in time order; the full ones are what the waitlist is for
  const byDay = useMemo(() => {
    const all: Offered[] = [...(slots ?? []).map((s) => ({ ...s, full: false })), ...full.map((s) => ({ ...s, full: true }))];
    all.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const m = new Map<string, Offered[]>();
    for (const s of all) {
      const d = localParts(Date.parse(s.startsAt), tz).date;
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return m;
  }, [slots, full, tz]);
  const waiting = useMemo(() => new Map(waitlist.filter((e) => e.sessionTypeId === typeId).map((e) => [e.startsAt, e])), [waitlist, typeId]);

  // The picked day, or the first day with a free time (else the first with any) once they load.
  const activeDay =
    day && byDay.has(day)
      ? day
      : slots
        ? (days.find((d) => byDay.get(d)?.some((s) => !s.full)) ?? days.find((d) => byDay.has(d)) ?? days[0])
        : null;

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

  async function joinList(s: Slot) {
    if (!typeId) return;
    setWaitBusy(true);
    try {
      await api.joinWaitlist(typeId, s.startsAt);
      haptic(18);
      toast(t('wl.joined'));
      setWaitFor(null);
      await refresh();
    } catch (e) {
      toast(errorText(t, codeOf(e)), 'error');
      setWaitFor(null);
      await load(); // a place may have opened meanwhile: it shows as free now
      await refresh();
    } finally {
      setWaitBusy(false);
    }
  }

  async function leaveList(entry: WaitlistEntry) {
    setWaitBusy(true);
    try {
      await api.leaveWaitlist(entry.id);
      toast(t('wl.left'));
      setWaitFor(null);
      await refresh();
    } catch (e) {
      toast(errorText(t, codeOf(e)), 'error');
    } finally {
      setWaitBusy(false);
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
            {daySlots.map((s) => {
              const onList = s.full && waiting.has(s.startsAt);
              return (
                <motion.button
                  key={s.startsAt}
                  className={`slot${s.full ? ' slot-full' : ''}`}
                  aria-pressed={s.full ? onList : pick?.startsAt === s.startsAt}
                  variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
                  onClick={() => (s.full ? setWaitFor(s) : setPick(s))}
                >
                  <span>
                    {fmtTime(s.startsAt, tz, lang)}
                    {s.full ? <small>{t(onList ? 'wl.waiting' : 'wl.full')}</small> : type && type.capacity > 1 && <small>{counted(t, lang, 'places', s.placesLeft)}</small>}
                  </span>
                </motion.button>
              );
            })}
          </motion.div>
        ) : (
          <Empty icon={<CalendarX size={26} />} title={slots.length ? t('book.noDay') : t('book.noDays', { trainer: coach })} />
        )}
        {daySlots.some((s) => s.full) && <p className="policy slots-hint">{t('wl.hint')}</p>}
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

      <Sheet open={!!waitFor} onClose={() => setWaitFor(null)} title={t('wl.title')}>
        {waitFor && type && (
          <>
            <div className="summary">
              <div className="summary-row">
                <span>{t('book.session')}</span>
                <b>{type.name}</b>
              </div>
              <div className="summary-row">
                <span>{t('book.day')}</span>
                <b>
                  {fmtLongDay(waitFor.startsAt, tz, lang)}, {fmtTime(waitFor.startsAt, tz, lang)}
                </b>
              </div>
              {waiting.get(waitFor.startsAt) && (
                <div className="summary-row">
                  <span>{t('wl.title')}</span>
                  <b>{t('wl.place', { n: waiting.get(waitFor.startsAt)!.position })}</b>
                </div>
              )}
            </div>
            {!waiting.has(waitFor.startsAt) && (
              <p className="policy">{t('wl.body', { when: `${fmtLongDay(waitFor.startsAt, tz, lang)}, ${fmtTime(waitFor.startsAt, tz, lang)}`, trainer: coach })}</p>
            )}
            <p className="policy">{t('wl.note')}</p>
            {waiting.has(waitFor.startsAt) ? (
              <Button size="lg" block variant="secondary" loading={waitBusy} onClick={() => leaveList(waiting.get(waitFor.startsAt)!)}>
                {t('wl.leave')}
              </Button>
            ) : (
              <Button size="lg" block loading={waitBusy} onClick={() => joinList(waitFor)}>
                {t('wl.join')}
              </Button>
            )}
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
