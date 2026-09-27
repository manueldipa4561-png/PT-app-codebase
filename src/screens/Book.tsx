import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarPlus, CalendarX, ChatCircleText, Check } from '@phosphor-icons/react';
import { AppError, addDays, firstName, localParts, whatsappLink, type Booking, type Slot } from '../domain.ts';
import { counted, errorText, fmtDay, fmtLongDay, fmtTime, useI18n } from '../i18n.ts';
import { Button, Empty, ErrorState, Sheet, Skeleton, haptic, useApp } from '../ui.tsx';
import { calendarLinks } from './Home.tsx';

const DAYS = 14;
const codeOf = (e: unknown) => (e instanceof AppError ? e.code : 'generic');

export function Book() {
  const { api, trainer, types, balance, refresh, toast } = useApp();
  const { t, lang } = useI18n();
  const tz = trainer.timezone;
  const coach = firstName(trainer.name);
  const [typeId, setTypeId] = useState(types[0]?.id);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<Slot | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Booking | null>(null);

  const today = localParts(Date.now(), tz).date;
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i)), [today]);
  const type = types.find((x) => x.id === typeId);
  const noCredits = (type?.credits ?? 0) > balance;

  const load = useCallback(async () => {
    if (!typeId) return;
    setSlots(null);
    setError(null);
    try {
      setSlots(await api.freeSlots(typeId, today, DAYS));
    } catch (e) {
      setError(codeOf(e));
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

  useEffect(() => {
    if (slots && (!day || !byDay.has(day))) setDay(days.find((d) => byDay.has(d)) ?? days[0]);
  }, [slots, byDay, day, days]);

  async function confirm() {
    if (!pick || !typeId) return;
    setBusy(true);
    try {
      const b = await api.book(typeId, pick.startsAt);
      haptic(18);
      setConfirming(false);
      setDone(b);
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

  if (done) return <Success booking={done} typeName={type?.name ?? ''} />;

  const weekday = (d: string) => new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const daySlots = (day && byDay.get(day)) || [];

  return (
    <>
      <h1 className="page-title display">{t('book.title')}</h1>
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
                aria-pressed={d === day}
                disabled={!slots || !has}
                onClick={() => {
                  setDay(d);
                  setPick(null);
                }}
              >
                <span className="day-wd">{weekday(d)}</span>
                <span className="day-n">{Number(d.slice(8))}</span>
                {has && <span className="day-dot" aria-hidden />}
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
          <motion.div key={day} className="slots" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.025 } } }}>
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

      <Sheet open={confirming && !!pick} onClose={() => setConfirming(false)} title={t('book.confirmTitle')}>
        {pick && type && (
          <>
            <div className="summary">
              <div className="summary-row">
                <span>{t('book.session')}</span>
                <b>{type.name}</b>
              </div>
              <div className="summary-row">
                <span>{t('book.day')}</span>
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
              <div className="summary-row">
                <span>{t('home.pack')}</span>
                <b>{t('book.after', { left: counted(t, lang, 'left', balance - type.credits) })}</b>
              </div>
            </div>
            <p className="policy">{t('book.policy', { h: trainer.cancelWindowHours })}</p>
            <Button size="lg" block loading={busy} onClick={confirm}>
              {t('book.confirm')}
            </Button>
          </>
        )}
      </Sheet>
    </>
  );
}

function Success({ booking, typeName }: { booking: Booking; typeName: string }) {
    const { trainer, navigate } = useApp();
    const { t, lang } = useI18n();
    const tz = trainer.timezone;
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
        <h2 className="display">{t('book.done')}</h2>
        <p>{t('book.doneBody', { when: `${fmtLongDay(booking.startsAt, tz, lang)}, ${fmtTime(booking.startsAt, tz, lang)}` })}</p>
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
