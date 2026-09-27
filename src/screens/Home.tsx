import { CalendarPlus, ChatCircleText, Clock, Gift, MapPin, ShoppingBag, UserCircle } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { HeroGL } from '../HeroGL.tsx';
import { TEMPLATES } from '../theme.ts';
import { firstName, googleCalendarUrl, icsEvent, whatsappLink, type Booking } from '../domain.ts';
import { counted, fmtLongDay, fmtMoney, fmtRelative, fmtTime, greetingKey, useI18n } from '../i18n.ts';
import { Button, Mark, Ring, useApp } from '../ui.tsx';

const rise = (i: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring' as const, stiffness: 260, damping: 28, delay: 0.06 * i },
});

export function calendarLinks(b: Booking, title: string, tz: string) {
  const ev = { uid: `${b.id}@pt-app`, title, location: b.location, startsAt: b.startsAt, endsAt: b.endsAt, stamp: new Date().toISOString() };
  return {
    ics: `data:text/calendar;charset=utf-8,${encodeURIComponent(icsEvent(ev))}`,
    google: googleCalendarUrl({ ...ev, description: tz }),
  };
}

export function Home() {
  const { trainer, me, bookings, balance, ledger, types, products, navigate, dark } = useApp();
  const { t, lang } = useI18n();
  const spec = TEMPLATES[trainer.template];
  const now = Date.now();
  const tz = trainer.timezone;
  const coach = firstName(trainer.name);
  const typeName = (id: string) => types.find((x) => x.id === id)?.name ?? '';

  const next = bookings
    .filter((b) => b.status === 'booked' && Date.parse(b.startsAt) > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const lastDone = bookings.filter((b) => b.status === 'attended').sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  const justTrained = !!lastDone && now - Date.parse(lastDone.startsAt) < 3 * 86_400_000;
  const packSize = Math.max(balance, ledger.find((l) => l.reason === 'pack')?.delta ?? 10);
  const words = trainer.name.trim().split(/\s+/);
  const lastWord = words.length > 1 ? words.pop() : undefined;
  const cal = next ? calendarLinks(next, `${typeName(next.sessionTypeId)} · ${trainer.name}`, tz) : null;
  const askPack = whatsappLink(trainer.whatsapp, t('home.askPackMsg', { trainer: coach }));
  const base = (dark ? spec.dark : spec.light).bg;

  return (
    <>
      <header className="hero">
        <div className="topbar">
          <Mark trainer={trainer} size={36} />
          <span className="topbar-name">{trainer.name}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => navigate('/profile')} aria-label={t('nav.profile')}>
            <UserCircle size={24} />
          </button>
        </div>
        <div className="hero-media">
          <HeroGL
            src={trainer.theme.cover}
            brand={trainer.theme.brand}
            accent={trainer.theme.accent ?? trainer.theme.brand}
            base={base}
            mode={spec.shader.mode}
            speed={spec.shader.speed}
            grain={spec.shader.grain}
            strength={spec.shader.strength}
            fade={trainer.template === 'energy' ? 1 : 0}
            alt={trainer.name}
          />
        </div>
        <motion.div className="hero-copy" {...rise(0)}>
          <p className="hero-greet">
            {t(greetingKey(now, tz))}, {firstName(me.client?.name ?? '')}
          </p>
          <h1 className="hero-name display">
            {words.join(' ')} {lastWord && <em>{lastWord}</em>}
          </h1>
          {trainer.tagline && <p className="hero-tag">{trainer.tagline}</p>}
        </motion.div>
      </header>

      <motion.section className="pad section" {...rise(1)}>
        {next && cal ? (
          <article className="card card-brand">
            <p className="card-eyebrow muted">
              {t('home.next')} · {fmtRelative(next.startsAt, now, lang)}
            </p>
            <p className="next-when display">
              {fmtLongDay(next.startsAt, tz, lang)}, {fmtTime(next.startsAt, tz, lang)}
            </p>
            <div className="next-meta muted">
              <span>
                <Clock size={16} aria-hidden /> {typeName(next.sessionTypeId)}
              </span>
              {next.location && (
                <span>
                  <MapPin size={16} aria-hidden /> {next.location}
                </span>
              )}
            </div>
            <div className="card-actions">
              <a className="btn btn-secondary" href={cal.ics} download="sessione.ics">
                <CalendarPlus size={18} aria-hidden /> {t('home.addCal')}
              </a>
              <a className="btn btn-secondary" href={cal.google} target="_blank" rel="noreferrer">
                Google
              </a>
              <button className="btn btn-secondary" onClick={() => navigate('/agenda')}>
                {t('home.manage')}
              </button>
            </div>
          </article>
        ) : (
          <article className="card">
            <p className="card-title display">{t('home.none')}</p>
            <p className="muted" style={{ margin: '6px 0 14px' }}>
              {t('home.noneBody')}
            </p>
            <Button onClick={() => navigate('/book')} icon={<CalendarPlus size={18} aria-hidden />}>
              {t('home.book')}
            </Button>
          </article>
        )}
      </motion.section>

      <motion.section className="pad section" {...rise(2)}>
        <article className="card pack">
          <Ring value={balance} max={packSize} label={counted(t, lang, 'left', balance)} />
          <div className="pack-text">
            <p className="card-eyebrow">{t('home.pack')}</p>
            <h3 className="display">{counted(t, lang, 'left', Math.max(0, balance))}</h3>
            {balance < 0 && <p>{t('home.owedBody', { left: counted(t, lang, 'sessions', -balance), trainer: coach })}</p>}
            {balance === 0 && <p>{t('home.emptyBody', { trainer: coach })}</p>}
            {balance > 0 && balance <= 2 && <p>{t('home.lowBody', { left: counted(t, lang, 'sessions', balance), trainer: coach })}</p>}
            {balance <= 2 && (
              <a className="btn btn-primary" style={{ marginTop: 12 }} href={askPack} target="_blank" rel="noreferrer">
                <ChatCircleText size={18} aria-hidden /> {t('home.askPack')}
              </a>
            )}
          </div>
        </article>
      </motion.section>

      {next && (
        <motion.div className="pad section" {...rise(3)}>
          <Button size="lg" block variant="secondary" onClick={() => navigate('/book')} icon={<CalendarPlus size={20} aria-hidden />}>
            {t('home.book')}
          </Button>
        </motion.div>
      )}

      <motion.section className="pad section" {...rise(4)}>
        <article className="card card-soft">
          <p className="card-title display">{justTrained ? t('home.afterTitle') : t('home.referTitle')}</p>
          <p className="muted" style={{ margin: '6px 0 14px' }}>
            {t('home.referBody')}
          </p>
          <Button onClick={() => navigate('/refer')} icon={<Gift size={18} aria-hidden />}>
            {t('home.referCta')}
          </Button>
        </article>
      </motion.section>

      {trainer.plan !== 'web' && products.length > 0 && (
        <motion.section className="pad section" {...rise(5)}>
          <h2 className="section-title">{t('home.shop', { trainer: coach })}</h2>
          <div className="shelf">
            {products.map((p) => (
              <button key={p.id} className="product" onClick={() => navigate('/shop')}>
                <span className="product-art" aria-hidden>
                  <ShoppingBag size={34} weight="duotone" />
                </span>
                <span className="product-name">{p.name}</span>
                <span className="product-price">{fmtMoney(p.priceCents, trainer.currency, lang)}</span>
              </button>
            ))}
          </div>
        </motion.section>
      )}

      <p className="muted pad" style={{ fontSize: 12, marginTop: 36, textAlign: 'center' }}>
        {t('home.madeBy', { trainer: trainer.name })}
      </p>
    </>
  );
}
