import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { CalendarBlank, CalendarPlus, Gift, House, ShoppingBag } from '@phosphor-icons/react';
import { createApi, DEFAULT_DEMO_TRAINER, DEMO_MODE, trainerKey, type Api, type Me } from './api.ts';
import { AppError, balanceOf, type Booking, type LedgerEntry, type Locale, type Product, type SessionType, type TrainerPublic } from './domain.ts';
import { TEMPLATES, initials, isDark, readableOn, themeVars } from './theme.ts';
import { I18nContext, errorText, translator, useI18n } from './i18n.ts';
import { AppContext, ErrorState, Skeleton, Toasts, useApp, useLiveRefresh, useToasts, type AppState } from './ui.tsx';
import type { DemoApi } from './demo.ts';
import { DemoPanel, saveCustomBrand } from './DemoPanel.tsx';
import { CUSTOM_SLUG, brandFromParam, demoQuery } from './demoBrand.ts';
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
      .then((a) => {
        if (DEMO_MODE) {
          // A demo link never dead-ends: a custom brand in the link is rebuilt on this device, and a
          // trainer this device does not know (a brand made in another browser) opens the default demo.
          const demo = a as DemoApi;
          const shared = brandFromParam(new URLSearchParams(location.search).get('brand'));
          if (shared && key === CUSTOM_SLUG) saveCustomBrand(demo, shared);
          if (!demo.db().trainers.some((x) => x.slug === key)) {
            const url = new URL(location.href);
            url.searchParams.set('t', DEFAULT_DEMO_TRAINER);
            url.searchParams.delete('brand');
            history.replaceState(null, '', url);
            setKey(DEFAULT_DEMO_TRAINER);
          }
        }
        setApi(a);
      })
      .catch((e) => {
        console.error('could not start the data source', e);
        setFailed(true);
      });
  }, []); // once, for the trainer the page was opened with

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
            url.searchParams.delete('brand'); // the panel puts it back for the custom brand
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

const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="([^"]+)"/;

/**
 * Turns true once a newer version is deployed than the one running (production only). Checked when
 * the app comes back to the foreground and every 5 minutes; the next change of screen loads it.
 */
function useOutdated() {
  const outdated = useRef(false);
  useEffect(() => {
    const running = document.querySelector('script[type="module"][src]')?.getAttribute('src');
    if (!import.meta.env.PROD || !running) return;
    const check = async () => {
      if (outdated.current || document.visibilityState !== 'visible') return;
      try {
        const latest = ENTRY_SCRIPT.exec(await (await fetch('/', { cache: 'no-store' })).text())?.[1];
        outdated.current = !!latest && latest !== running;
      } catch {
        /* offline: the next check tries again */
      }
    };
    const timer = window.setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return outdated;
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
  // The demo switches trainer without a reload: installing must give the trainer on screen.
  if (DEMO_MODE) {
    const query = demoQuery(t.slug, new URLSearchParams(location.search).get('brand'));
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/manifest.webmanifest${query}`);
  }
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

  // Loads can overlap (switching trainer in the demo, a refresh during a slow one): only the
  // latest may write, so an older response never replaces a newer trainer's data.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const t = await api.getTrainer(key);
      const [ty, pr, m] = await Promise.all([api.sessionTypes(t.id), api.products(t.id), api.me(t.id)]);
      const [bk, lg] = m.client ? await Promise.all([api.myBookings(t.id), api.myLedger(t.id)]) : [[], []];
      if (mine !== latest.current) return;
      setTrainer(t);
      setTypes(ty);
      setProducts(pr);
      setMe(m);
      setBookings(bk);
      setLedger(lg);
      setError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      console.error('loading the trainer app failed', e);
      setError(e instanceof AppError ? e.code : 'generic');
    }
  }, [api, key]);

  useEffect(() => {
    void load();
  }, [load, version]);
  useLiveRefresh(load);

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

  const outdated = useOutdated();
  const navigate = useCallback(
    (to: string) => {
      const url = new URL(to, location.origin);
      // the demo's ?t= and ?brand= follow every screen, so a link copied from any page still opens this brand
      if (!url.search) url.search = location.search;
      // A newer version is out: this change of screen loads it (moving between screens loses nothing).
      if (outdated.current) {
        location.assign(url.pathname + url.search);
        return;
      }
      history.pushState(null, '', url.pathname + url.search);
      setPath(url.pathname);
    },
    [outdated],
  );

  const setLang = useCallback((l: Locale) => {
    setLangState(l);
    try {
      localStorage.setItem('pt-lang', l);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  }, []);
  const activeLang: Locale = lang ?? trainer?.locale ?? 'it';
  // Stable context values: a toast or the morph timer does not re-render every consumer.
  const i18n = useMemo(() => ({ lang: activeLang, t: translator(activeLang), setLang }), [activeLang, setLang]);
  const dark = trainer ? isDark(TEMPLATES[trainer.template], trainer.theme, systemDark) : false;
  const state = useMemo<AppState | null>(
    () =>
      trainer && me
        ? {
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
          }
        : null,
    [api, trainer, types, products, me, bookings, ledger, dark, load, path, navigate, show],
  );

  if (error && !trainer) {
    return (
      <I18nContext.Provider value={i18n}>
        <div className="app" style={{ '--bg': '#f3f5f9', '--ink': '#0a1330', '--muted': '#56607a' } as CSSProperties}>
          <ErrorState text={errorText(i18n.t, error)} onRetry={error === 'TENANT_NOT_FOUND' ? undefined : load} />
        </div>
      </I18nContext.Provider>
    );
  }
  if (!trainer || !me || !state) return <Splash />;

  const vars = themeVars(TEMPLATES[trainer.template], trainer.theme, dark) as CSSProperties;
  const invite = path.startsWith('/r/') ? decodeURIComponent(path.split('/')[2] ?? '') : undefined;
  let screen: ReactNode;
  let screenKey = path;
  let tabs = false;
  if (me.isOwner && (path.startsWith('/admin') || !me.client)) {
    // The trainer's own app opens on the panel; a trainer who is also a client gets there from Profile.
    screen = <Trainer />;
    screenKey = 'admin';
  } else if (!me.client) {
    screen = <Join referralCode={invite} />;
    // a new trainer or invite starts the form over: nothing typed is sent to the wrong one
    screenKey = `join:${trainer.id}:${invite ?? ''}`;
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
          <div className={morph ? 'app morph' : 'app'} data-template={trainer.template} data-scheme={dark ? 'dark' : 'light'} style={vars}>
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
