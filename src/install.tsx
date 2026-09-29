// "Scaricare l'app" from the web: it installs on the home screen, no store needed. Chrome and Edge
// (Android, computer) have their own install prompt; on iPhone it takes two taps in the Share menu.
import { useState } from 'react';
import { ArrowDown, ArrowSquareOut, Copy, DeviceMobile, DotsThree, DotsThreeVertical, Export, PlusSquare, type Icon } from '@phosphor-icons/react';
import { errorText, useI18n, type Key } from './i18n.ts';
import { Button, Sheet, useApp } from './ui.tsx';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Chrome fires this once, often before React mounts: keep it for when the button is tapped.
let deferred: InstallPrompt | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
  });
}

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
// iPadOS says it is a Mac: the touch screen gives it away.
const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
// Apps that open links inside themselves (Instagram, Facebook, TikTok...) cannot install anything.
const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|musical_ly|BytedanceWebview|LinkedInApp|Snapchat/i.test(ua);
// Safari on iPhone gets an arrow pointing at its toolbar: Share sits in the middle of it, but from
// Safari 26 it hides behind the ··· button at the bottom right. Other iOS browsers get the steps only.
const iphoneSafari = !inApp && /iphone|ipod/i.test(ua) && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPT\/|GSA\/|Ddg\//.test(ua);
const safari26 = Number(/Version\/(\d+)/.exec(ua)?.[1]) >= 26;
const kind = inApp ? 'inApp' : iphoneSafari ? (safari26 ? 'safari26' : 'safari') : ios ? 'ios' : 'menu';

export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

const STEPS: Record<typeof kind, [Icon, Key][]> = {
  inApp: [
    [DotsThree, 'install.inApp1'],
    [ArrowSquareOut, 'install.inApp2'],
  ],
  safari: [
    [Export, 'install.safari1'],
    [PlusSquare, 'install.ios2'],
  ],
  safari26: [
    [DotsThree, 'install.safari26'],
    [PlusSquare, 'install.ios2'],
  ],
  ios: [
    [Export, 'install.ios1'],
    [PlusSquare, 'install.ios2'],
  ],
  menu: [
    [DotsThreeVertical, 'install.menu1'],
    [PlusSquare, 'install.menu2'],
  ],
};

/**
 * "Installa l'app": the browser's own prompt when it offers one, otherwise a sheet with the taps to do.
 * Before sign-in (the join screen) it is a compact button and tells iPhone users to install first:
 * the home-screen app keeps its own storage, so a session started in Safari does not follow it.
 */
export function InstallApp({ beforeSignIn = false }: { beforeSignIn?: boolean }) {
  const { toast } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (isInstalled()) return null;

  async function install() {
    const prompt = deferred;
    if (!prompt) return setOpen(true);
    deferred = null; // each prompt works once
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') toast(t('install.done'));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      toast(t('install.copied'));
    } catch {
      toast(errorText(t, 'generic'), 'error');
    }
  }

  return (
    <>
      <Button variant="secondary" block={!beforeSignIn} icon={<DeviceMobile size={18} aria-hidden />} onClick={install}>
        {t('install.title')}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('install.title')}>
        <ol className="steps">
          {STEPS[kind].map(([StepIcon, key]) => (
            <li key={key}>
              <StepIcon size={24} aria-hidden />
              <span>{t(key)}</span>
            </li>
          ))}
        </ol>
        <p className="muted">{t(inApp ? 'install.inAppNote' : !ios ? 'install.after' : beforeSignIn ? 'install.iosFirst' : 'install.iosAgain')}</p>
        {inApp && (
          <Button variant="secondary" block icon={<Copy size={18} aria-hidden />} onClick={copyLink}>
            {t('install.copy')}
          </Button>
        )}
        {iphoneSafari && <ArrowDown className={safari26 ? 'install-arrow install-arrow-right' : 'install-arrow'} size={36} weight="bold" aria-hidden />}
      </Sheet>
    </>
  );
}
