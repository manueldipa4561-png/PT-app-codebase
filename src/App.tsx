import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { CalendarBlank, CalendarPlus, Gift, House, ShoppingBag } from '@phosphor-icons/react';
import { createApi, DEFAULT_DEMO_TRAINER, DEMO_MODE, trainerKey, type Api, type Me } from './api.ts';
import { AppError, balanceOf, type Booking, type LedgerEntry, type Locale, type Product, type SessionType, type TrainerPublic } from './domain.ts';
import { TEMPLATES, initials, isDark, readableOn, themeVars } from './theme.ts';
import { I18nContext, errorText, translator, useI18n } from './i18n.ts';
import { AppContext, ErrorState, Skeleton, Toasts, useApp, useToasts, type AppState } from './ui.tsx';
import type { DemoApi } from './demo.ts';
import { DemoPanel } from './DemoPanel.tsx';
import { Home } from './screens/Home.tsx';
import { Book } from './screens/Book.tsx';
import { Agenda } from './screens/Agenda.tsx';
import { Refer } from './screens/Refer.tsx';
import { Shop } from './screens/Shop.tsx';
import { Profile } from './screens/Profile.tsx';
import { Join } from './screens/Join.tsx';
import { Trainer } from './screens/Trainer.tsx';

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(() => trainerKey() ?? (DEMO_MODE ? DEFAULT_DEMO_TRAINER : location.hostname));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    createApi()
      .then(setApi)
      .catch((e) => {
        console.error('could not start the data source', e);
        setFailed(true);
      });
  }, []);

  if (failed) return <p style={{ padding: 24 }}>Impossibile avviare l'app. Ricarica la pagina.</p>;
  if (!api) return null;

  const app = <TrainerApp api={api} trainerKey={key} version={version} />;
  if (!DEMO_MODE) return <div className="live-shell">{app}</div>;
  return (
    <div className="stage">
      <div className="stage-inner">
        <DemoPanel
          api={api as DemoApi}
          current={key}
          onPick={(slug) => {
            setKey(slug);
            const url = new URL(location.href);
            url.searchParams.set('t', slug);
            history.replaceState(null, '', url);
          }}
          onChange={() => setVersion((v) => v + 1)}
        />
        <div className="device">{app}</div>
      </div>
    </div>
  );
}

function storedLang(): Locale | null {
  try {
    const v = localStorage.getItem('pt-lang');
    return v === 'it' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Title, theme color and home-screen icon of this trainer's app (the edge function does the same server side). */
function applyIdentity(t: TrainerPublic) {
  document.title = t.name;
  const meta = (name: string, content: string) => {
    let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.name = name;
      document.head.append(el);
    }
    el.content = content;
  };
  meta('theme-color', t.theme.brand);
  meta('apple-mobile-web-app-title', t.name);
  let icon = t.theme.logo;
  if (!icon) {
    const c = document.createElement('canvas');
    c.width = c.height = 180;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = t.theme.brand;
      g.fillRect(0, 0, 180, 180);
      g.fillStyle = readableOn(t.theme.brand);
      g.font = '700 74px "Geist Variable", system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(initials(t.name), 90, 96);
      icon = c.toDataURL('image/png');
    }
  }
  if (icon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      document.head.append(link);
    }
    link.href = icon;
  }
}

function TrainerApp({ api, trainerKey: key, version }: { api: Api; trainerKey: string; version: number }) {
  const [trainer, setTrainer] = useState<TrainerPublic | null>(null);
  const [types, setTypes] = useState<SessionType[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLangState] = useState<Locale | null>(storedLang);
  const [path, setPath] = useState(() => location.pathname);
  const { items, show } = useToasts();
  const systemDark = useSystemDark();

  const load = useCallback(async () => {
    try {
      const t = await api.getTrainer(key);
      const [ty, pr, m] = await Promise.all([api.sessionTypes(t.id), api.products(t.id), api.me(t.id)]);
      const [bk, lg] = m.client ? await Promise.all([api.myBookings(t.id), api.myLedger(t.id)]) : [[], []];
      setTrainer(t);
      setTypes(ty);
      setProducts(pr);
      setMe(m);
      setBookings(bk);
      setLedger(lg);
      setError(null);
    } catch (e) {
      console.error('loading the trainer app failed', e);
      setError(e instanceof AppError ? e.code : 'generic');
    }
  }, [api, key]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (trainer) applyIdentity(trainer);
  }, [trainer]);

  // Enable the color morph after the first paint, so it only animates live brand edits.
  const [morph, setMorph] = useState(false);
  useEffect(() => {
    if (!trainer || morph) return;
    const id = window.setTimeout(() => setMorph(true), 600);
    return () => window.clearTimeout(id);
  }, [trainer, morph]);

  const navigate = useCallback((to: string) => {
    const url = new URL(to, location.origin);
    const t = new URLSearchParams(location.search).get('t');
    if (t && !url.searchParams.has('t')) url.searchParams.set('t', t);
    history.pushState(null, '', url.pathname + url.search);
    setPath(url.pathname);
  }, []);

  const activeLang: Locale = lang ?? trainer?.locale ?? 'it';
  const i18n = {
    lang: activeLang,
    t: translator(activeLang),
    setLang: (l: Locale) => {
      setLangState(l);
      try {
        localStorage.setItem('pt-lang', l);
      } catch {
        /* private mode: the choice lasts for this visit */
      }
    },
  };

  if (error && !trainer) {
    return (
      <I18nContext.Provider value={i18n}>
        <div className="app" style={{ '--bg': '#f3f5f9', '--ink': '#0a1330', '--muted': '#56607a' } as CSSProperties}>
          <ErrorState text={errorText(i18n.t, error)} onRetry={error === 'TENANT_NOT_FOUND' ? undefined : load} />
        </div>
      </I18nContext.Provider>
    );
  }
  if (!trainer || !me) return <Splash />;

  const spec = TEMPLATES[trainer.template];
  const dark = isDark(spec, trainer.theme, systemDark);
  const vars = themeVars(spec, trainer.theme, dark) as CSSProperties;
  const state: AppState = {
    api,
    trainer,
    types,
    products,
    me,
    bookings,
    ledger,
    balance: me.client ? balanceOf(ledger, me.client.id) : 0,
    dark,
    refresh: load,
    path,
    navigate,
    toast: show,
  };

  const invite = path.startsWith('/r/') ? decodeURIComponent(path.split('/')[2] ?? '') : undefined;
  let screen: ReactNode;
  let screenKey = path;
  let tabs = false;
  if (!me.client && !(me.isOwner && path.startsWith('/admin'))) {
    screen = <Join referralCode={invite} />;
    screenKey = 'join';
  } else if (path.startsWith('/admin') && me.isOwner) {
    screen = <Trainer />;
    screenKey = 'admin';
  } else {
    tabs = true;
    if (path.startsWith('/book')) screen = <Book />;
    else if (path.startsWith('/agenda')) screen = <Agenda />;
    else if (path.startsWith('/refer')) screen = <Refer />;
    else if (path.startsWith('/shop') && trainer.plan !== 'web') screen = <Shop />;
    else if (path.startsWith('/profile')) screen = <Profile />;
    else {
      screen = <Home />;
      screenKey = '/';
    }
  }

  return (
    <I18nContext.Provider value={i18n}>
      <AppContext.Provider value={state}>
        <MotionConfig reducedMotion="user">
          <div className={morph ? 'app morph' : 'app'} data-template={trainer.template} style={vars}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.main
                key={screenKey}
                className="screen"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8, transition: { duration: 0.12 } }}
                transition={{ type: 'spring', stiffness: 380, damping: 34 }}
              >
                {screen}
              </motion.main>
            </AnimatePresence>
            {tabs && <TabBar />}
            <Toasts items={items} />
          </div>
        </MotionConfig>
      </AppContext.Provider>
    </I18nContext.Provider>
  );
}

function TabBar() {
  const { t } = useI18n();
  const { path, navigate, trainer } = useApp();
  const tabs = [
    { to: '/', Icon: House, label: t('nav.home') },
    { to: '/book', Icon: CalendarPlus, label: t('nav.book') },
    { to: '/agenda', Icon: CalendarBlank, label: t('nav.agenda') },
    { to: '/refer', Icon: Gift, label: t('nav.refer') },
    ...(trainer.plan !== 'web' ? [{ to: '/shop', Icon: ShoppingBag, label: t('nav.shop') }] : []),
  ];
  return (
    <nav className="tabbar" aria-label={trainer.name}>
      {tabs.map(({ to, Icon, label }) => {
        const active = to === '/' ? path === '/' || path === '' : path.startsWith(to);
        return (
          <a
            key={to}
            href={to}
            className="tab"
            aria-current={active ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(to);
            }}
          >
            {active && <motion.span layoutId="tab-pill" className="tab-pill" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
            <Icon size={22} weight={active ? 'fill' : 'regular'} aria-hidden />
            <span>{label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function Splash() {
  return (
    <div className="app" style={{ '--bg': '#0d0e11', '--surface': '#16171b', '--surface-2': '#1d1f24' } as CSSProperties} aria-busy="true">
      <div className="pad" style={{ paddingTop: 120, display: 'grid', gap: 14 }}>
        <Skeleton h={220} r={24} />
        <Skeleton h={28} w="60%" />
        <Skeleton h={18} w="80%" />
      </div>
    </div>
  );
}
