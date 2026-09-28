import { useEffect, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { Gift } from '@phosphor-icons/react';
import { AppError, REFERRAL_CODE, isEmail } from '../domain.ts';
import { errorText, useI18n } from '../i18n.ts';
import { Button, Field, Mark, useApp } from '../ui.tsx';
import { BrandCover } from './Home.tsx';

const REF_KEY = 'pt-ref';
const readRef = () => {
  try {
    return localStorage.getItem(REF_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Sign in with a 6-digit email code (not a magic link: an iPhone home-screen app has its own storage). */
export function Join({ referralCode }: { referralCode?: string }) {
  const { api, trainer, me, refresh, dark } = useApp();
  const { t } = useI18n();
  const [step, setStep] = useState<'email' | 'code' | 'profile'>(me.userId ? 'profile' : 'email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [ref, setRef] = useState((referralCode ?? readRef()).toUpperCase());
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inAppBrowser = /Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent);

  useEffect(() => {
    if (!referralCode) return;
    try {
      localStorage.setItem(REF_KEY, referralCode.toUpperCase());
    } catch {
      /* the code stays visible on screen to type again after installing */
    }
  }, [referralCode]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(t, e instanceof AppError ? e.code : 'generic'));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'email') {
      if (!isEmail(email.trim())) return setError(errorText(t, 'INVALID_INPUT'));
      void run(async () => {
        await api.sendCode(email.trim());
        setStep('code');
      });
    } else if (step === 'code') {
      void run(async () => {
        await api.verifyCode(email.trim(), code);
        setStep('profile');
        await refresh();
      });
    } else {
      void run(async () => {
        await api.join(trainer.id, { name, phone: phone || undefined, referralCode: REFERRAL_CODE.test(ref) ? ref : undefined, acceptTerms: terms });
        try {
          localStorage.removeItem(REF_KEY);
        } catch {
          /* nothing to clean */
        }
        await refresh();
      });
    }
  };

  return (
    <>
    <div className="join-cover">
      <BrandCover trainer={trainer} dark={dark} />
    </div>
    <div className="pad join-body">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
        <Mark trainer={trainer} size={56} />
        <h1 className="display" style={{ margin: '20px 0 8px', fontSize: 44 }}>
          {t('join.welcome', { trainer: trainer.name })}
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: '32ch' }}>
          {t('join.lead')}
        </p>
        {ref && (
          <p className="badge badge-brand" style={{ marginTop: 16 }}>
            <Gift size={14} aria-hidden style={{ marginRight: 6 }} />
            {t('join.invited')}: {ref}
          </p>
        )}
        {inAppBrowser && (
          <p className="card card-soft" style={{ marginTop: 16, fontSize: 14 }}>
            {t('join.inApp')}
          </p>
        )}
      </motion.div>

      <form className="card stack" style={{ marginTop: 28 }} onSubmit={submit} noValidate>
        {step === 'email' && (
          <Field label={t('join.email')} error={error}>
            <input className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
        )}
        {step === 'code' && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {t('join.codeSent', { email })}
            </p>
            <Field label={t('join.code')} error={error}>
              <input
                className="input code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Button type="button" variant="ghost" onClick={() => setStep('email')}>
              {t('join.changeEmail')}
            </Button>
          </>
        )}
        {step === 'profile' && (
          <>
            <p className="card-title display">{t('join.profile')}</p>
            <Field label={t('join.name')}>
              <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label={t('join.phone')}>
              <input className="input" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label={t('join.referral')}>
              <input className="input" value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} autoCapitalize="characters" />
            </Field>
            <label className="check">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>{t('join.terms', { h: trainer.cancelWindowHours })}</span>
            </label>
            {error && (
              <p className="field-error" role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            )}
          </>
        )}
        <Button type="submit" size="lg" block loading={busy} disabled={step === 'code' ? code.length !== 6 : step === 'profile' ? !name.trim() || !terms : false}>
          {step === 'email' ? t('join.sendCode') : step === 'code' ? t('join.verify') : t('join.start')}
        </Button>
        {api.mode === 'demo' && step !== 'profile' && (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('join.demo')}
          </p>
        )}
      </form>
    </div>
    </>
  );
}
