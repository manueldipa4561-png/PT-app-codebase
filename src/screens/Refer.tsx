import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { motion } from 'motion/react';
import { ChatCircleText, Copy, Gift, ShareNetwork, UserPlus, Users } from '@phosphor-icons/react';
import { whatsappLink } from '../domain.ts';
import type { ReferralView } from '../api.ts';
import { counted, useI18n, type Key } from '../i18n.ts';
import { Button, Empty, Sheet, Skeleton, haptic, useApp } from '../ui.tsx';

export function Refer() {
  const { api, trainer, me, toast } = useApp();
  const { t, lang } = useI18n();
  const [invites, setInvites] = useState<ReferralView[] | null>(null);
  const [rules, setRules] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const code = me.client?.referralCode ?? '';
  const link = `${location.origin}/r/${code}${api.mode === 'demo' ? `?t=${trainer.slug}` : ''}`;
  const message = t('refer.shareMsg', { trainer: trainer.name, link });

  useEffect(() => {
    api
      .myReferrals(trainer.id)
      .then(setInvites)
      .catch((e) => {
        console.error('invites', e);
        setInvites([]);
      });
  }, [api, trainer.id]);

  // Tilt and sheen follow the pointer through CSS variables: no React re-render per frame.
  function onMove(e: PointerEvent<HTMLDivElement>) {
    const el = card.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--ry', `${(x - 0.5) * 14}deg`);
    el.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    el.style.setProperty('--mx', `${x * 100}%`);
    el.style.setProperty('--my', `${y * 100}%`);
  }
  function onLeave() {
    const el = card.current;
    if (!el) return;
    for (const [k, v] of [['--rx', '0deg'], ['--ry', '0deg'], ['--mx', '50%'], ['--my', '50%']]) el.style.setProperty(k, v);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      haptic();
      toast(t('refer.copied'));
    } catch (e) {
      console.warn('clipboard', e);
      toast(link);
    }
  }
  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: trainer.name, text: message, url: link });
      } catch {
        /* the person closed the share sheet */
      }
    } else await copy();
  }

  const statusKey = (s: ReferralView['status']): Key => (s === 'rewarded' ? 'refer.rewarded' : s === 'reversed' ? 'refer.reversed' : 'refer.pending');

  return (
    <>
      <h1 className="page-title display">{t('refer.title')}</h1>
      <p className="page-lead">
        {t('refer.sub', { you: counted(t, lang, 'sessions', trainer.bonusReferrer), friend: counted(t, lang, 'sessions', trainer.bonusReferred) })}
      </p>

      <motion.div
        className="pass-wrap section"
        initial={{ opacity: 0, y: 24, rotateX: 18 }}
        animate={{ opacity: 1, y: 0, rotateX: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
      >
        <div className="pass" ref={card} onPointerMove={onMove} onPointerLeave={onLeave}>
          <div className="row">
            <span className="pass-label">{t('refer.pass')}</span>
            <span className="spacer" />
            <Gift size={22} weight="duotone" aria-hidden />
          </div>
          <span className="pass-trainer">{trainer.name}</span>
          <span className="pass-label" style={{ marginTop: 'auto' }}>
            {t('refer.code')}
          </span>
          <span className="pass-code display" style={{ marginTop: 0 }}>
            {code}
          </span>
        </div>
      </motion.div>

      <section className="pad section stack">
        <div className="share-row">
          <Button onClick={share} icon={<ShareNetwork size={18} aria-hidden />}>
            {t('refer.share')}
          </Button>
          <a className="btn btn-secondary" href={whatsappLink(null, message)} target="_blank" rel="noreferrer">
            <ChatCircleText size={18} aria-hidden /> {t('refer.whatsapp')}
          </a>
        </div>
        <Button variant="secondary" block onClick={copy} icon={<Copy size={18} aria-hidden />}>
          {t('refer.copy')}
        </Button>
      </section>

      <section className="pad section">
        <h2 className="section-title">{t('refer.how')}</h2>
        <ul className="how" style={{ margin: 0, padding: 0 }}>
          <li>
            <span className="how-icon">
              <ShareNetwork size={18} aria-hidden />
            </span>
            {t('refer.how1')}
          </li>
          <li>
            <span className="how-icon">
              <UserPlus size={18} aria-hidden />
            </span>
            {t('refer.how2')}
          </li>
          <li>
            <span className="how-icon">
              <Gift size={18} aria-hidden />
            </span>
            {t('refer.how3')}
          </li>
        </ul>
      </section>

      <section className="pad section">
        <h2 className="section-title">{t('refer.friends')}</h2>
        {!invites ? (
          <Skeleton h={64} r={18} />
        ) : invites.length === 0 ? (
          <Empty icon={<Users size={26} />} title={t('refer.none')} />
        ) : (
          <div className="list">
            {invites.map((r) => (
              <div key={r.id} className="item">
                <div className="item-main">
                  <div className="item-title">{r.name}</div>
                </div>
                <span className={`badge${r.status === 'rewarded' ? ' badge-brand' : ''}`}>{t(statusKey(r.status))}</span>
              </div>
            ))}
          </div>
        )}
        <Button variant="ghost" onClick={() => setRules(true)} style={{ marginTop: 12 }}>
          {t('refer.rules')}
        </Button>
      </section>

      <Sheet open={rules} onClose={() => setRules(false)} title={t('refer.rules')}>
        <p className="muted" style={{ margin: 0 }}>
          {t('refer.rulesBody', { trainer: trainer.name })}
        </p>
      </Sheet>
    </>
  );
}
