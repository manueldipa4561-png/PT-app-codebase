import { useState } from 'react';
import { motion } from 'motion/react';
import { CalendarBlank } from '@phosphor-icons/react';
import { AppError, cancelOutcome, type Booking } from '../domain.ts';
import { errorText, fmtTime, useI18n, type Key } from '../i18n.ts';
import { Button, Empty, Segmented, Sheet, haptic, useApp } from '../ui.tsx';

export function Agenda() {
  const { api, trainer, bookings, types, refresh, toast } = useApp();
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<'up' | 'past'>('up');
  const [target, setTarget] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = trainer.timezone;
  const now = Date.now();
  const locale = lang === 'it' ? 'it-IT' : 'en-GB';

  const isUpcoming = (b: Booking) => b.status === 'booked' && Date.parse(b.startsAt) > now;
  const upcoming = bookings.filter(isUpcoming).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = bookings.filter((b) => !isUpcoming(b)).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const list = tab === 'up' ? upcoming : past;
  const outcome = target ? cancelOutcome(target, false, now, trainer.cancelWindowHours) : null;
  const late = typeof outcome === 'object' && outcome?.status === 'late_cancel';

  async function cancel() {
    if (!target) return;
    setBusy(true);
    try {
      await api.cancel(target.id);
      haptic();
      toast(t('agenda.cancelled'));
      setTarget(null);
      await refresh();
    } catch (e) {
      toast(errorText(t, e instanceof AppError ? e.code : 'generic'), 'error');
      setTarget(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title display">{t('agenda.title')}</h1>
      <div className="pad section" style={{ marginTop: 16 }}>
        <Segmented<'up' | 'past'>
          id="agenda"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'up', label: `${t('agenda.upcoming')} (${upcoming.length})` },
            { value: 'past', label: t('agenda.past') },
          ]}
        />
      </div>
      <section className="pad section">
        {list.length === 0 ? (
          <Empty icon={<CalendarBlank size={26} />} title={tab === 'up' ? t('agenda.empty') : t('agenda.emptyPast')} />
        ) : (
          <motion.div className="list" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.03 } } }}>
            {list.map((b) => {
              const d = new Date(b.startsAt);
              return (
                <motion.div key={b.id} className="item" variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
                  <div className="item-date">
                    <b>{new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric' }).format(d)}</b>
                    <span>{new Intl.DateTimeFormat(locale, { timeZone: tz, month: 'short' }).format(d)}</span>
                  </div>
                  <div className="item-main">
                    <div className="item-title">{types.find((x) => x.id === b.sessionTypeId)?.name}</div>
                    <div className="item-sub">
                      {new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'long' }).format(d)}, {fmtTime(b.startsAt, tz, lang)}
                      {b.location ? `, ${b.location}` : ''}
                    </div>
                  </div>
                  {isUpcoming(b) ? (
                    <Button variant="ghost" onClick={() => setTarget(b)}>
                      {t('agenda.cancel')}
                    </Button>
                  ) : (
                    <span className={`badge${b.status === 'attended' ? ' badge-brand' : b.status === 'late_cancel' || b.status === 'no_show' ? ' badge-warn' : ''}`}>
                      {t(`status.${b.status}` as Key)}
                    </span>
                  )}
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </section>

      <Sheet open={!!target} onClose={() => setTarget(null)} title={t('agenda.cancelTitle')}>
        <p style={{ margin: '0 0 20px' }} className={late ? '' : 'muted'}>
          {late ? t('agenda.cancelLate', { h: trainer.cancelWindowHours }) : t('agenda.cancelFree')}
        </p>
        <div className="grid-2">
          <Button variant="secondary" onClick={() => setTarget(null)}>
            {t('agenda.keep')}
          </Button>
          <Button variant="danger" loading={busy} onClick={cancel}>
            {t('agenda.confirmCancel')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
