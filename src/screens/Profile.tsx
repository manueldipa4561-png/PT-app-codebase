import { useEffect, useState } from 'react';
import { ChatCircleText, DeviceMobile, ShieldCheck, SignOut, Trash } from '@phosphor-icons/react';
import { AppError, firstName, whatsappLink, type Locale } from '../domain.ts';
import { counted, errorText, fmtDay, useI18n, type Key } from '../i18n.ts';
import { initials } from '../theme.ts';
import { Button, Segmented, Sheet, useApp } from '../ui.tsx';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}
let deferredInstall: InstallPrompt | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as InstallPrompt;
  });
}

export function Profile() {
  const { api, trainer, me, ledger, refresh, navigate, toast } = useApp();
  const { t, lang, setLang } = useI18n();
  const [deleting, setDeleting] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState(false);
  const [canInstall, setCanInstall] = useState(!!deferredInstall);
  const coach = firstName(trainer.name);
  const client = me.client;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches;
  const confirmWord = t('profile.deleteWord');

  useEffect(() => {
    const on = () => setCanInstall(true);
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);

  async function signOut() {
    await api.signOut();
    navigate('/');
    await refresh();
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteAccount(trainer.id);
      setDeleting(false);
      navigate('/');
      await refresh();
    } catch (e) {
      toast(errorText(t, e instanceof AppError ? e.code : 'generic'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pad" style={{ paddingTop: 'calc(28px + env(safe-area-inset-top))' }}>
        <div className="row">
          <span className="mark mark-mono display" style={{ width: 64, height: 64, fontSize: 24 }} aria-hidden>
            {initials(client?.name ?? '')}
          </span>
          <div>
            <h1 className="display" style={{ margin: 0, fontSize: 30 }}>
              {client?.name}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {me.email}
            </p>
          </div>
        </div>
      </div>

      <section className="pad section">
        <h2 className="section-title">{t('profile.language')}</h2>
        <Segmented<Locale>
          id="lang"
          value={lang}
          onChange={setLang}
          options={[
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
        />
      </section>

      {!installed && (
        <section className="pad section">
          <article className="card card-soft">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <DeviceMobile size={26} aria-hidden />
              <div>
                <p className="card-title display" style={{ fontSize: 20 }}>
                  {t('profile.install')}
                </p>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
                  {ios ? t('profile.installIos') : t('profile.installAndroid')}
                </p>
                {canInstall && (
                  <Button style={{ marginTop: 12 }} onClick={() => deferredInstall?.prompt()}>
                    {t('profile.installNow')}
                  </Button>
                )}
              </div>
            </div>
          </article>
        </section>
      )}

      <section className="pad section stack">
        <a className="btn btn-secondary btn-block" href={whatsappLink(trainer.whatsapp, '')} target="_blank" rel="noreferrer">
          <ChatCircleText size={18} aria-hidden /> {t('profile.contact', { trainer: coach })}
        </a>
        <Button variant="secondary" block icon={<ShieldCheck size={18} aria-hidden />} onClick={() => setRules(true)}>
          {t('profile.rules')}
        </Button>
      </section>

      <section className="pad section">
        <h2 className="section-title">{t('profile.history')}</h2>
        {ledger.length === 0 ? (
          <p className="muted">{t('profile.noHistory')}</p>
        ) : (
          <div className="list">
            {ledger.slice(0, 12).map((l) => (
              <div key={l.id} className="item">
                <div className="item-main">
                  <div className="item-title">{t(`ledger.${l.reason}` as Key)}</div>
                  <div className="item-sub">{fmtDay(l.createdAt, trainer.timezone, lang)}</div>
                </div>
                <span className={`badge${l.delta > 0 ? ' badge-brand' : ''}`}>
                  {l.delta > 0 ? '+' : ''}
                  {counted(t, lang, 'sessions', l.delta)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="pad section stack">
        <Button variant="secondary" block icon={<SignOut size={18} aria-hidden />} onClick={signOut}>
          {t('profile.signOut')}
        </Button>
        <Button variant="danger" block icon={<Trash size={18} aria-hidden />} onClick={() => setDeleting(true)}>
          {t('profile.delete')}
        </Button>
      </section>

      <Sheet open={rules} onClose={() => setRules(false)} title={t('profile.rules')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('book.policy', { h: trainer.cancelWindowHours })}
        </p>
        <p className="muted">{t('refer.rulesBody', { trainer: trainer.name })}</p>
      </Sheet>

      <Sheet open={deleting} onClose={() => setDeleting(false)} title={t('profile.deleteTitle')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('profile.deleteBody')}
        </p>
        <label className="field" style={{ margin: '16px 0' }}>
          <span className="field-label">{t('profile.deleteType', { word: confirmWord })}</span>
          <input className="input" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" />
        </label>
        <Button variant="danger" block loading={busy} disabled={word.trim().toUpperCase() !== confirmWord} onClick={remove}>
          {t('profile.delete')}
        </Button>
      </Sheet>
    </>
  );
}
