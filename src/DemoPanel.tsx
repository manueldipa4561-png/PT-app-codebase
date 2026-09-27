// The sales demo around the phone: switch trainer, switch client / trainer view, and build a
// trainer's brand live while they watch ("the list to choose from"). Demo mode only.
import { useEffect, useState, type ChangeEvent } from 'react';
import { ArrowCounterClockwise, Copy, Eye, Palette, UploadSimple, X } from '@phosphor-icons/react';
import type { DemoApi } from './demo.ts';
import { COVER_CHOICES, DEMO_USER, PHOTOS, type DemoTrainer } from './seed.ts';
import { TEMPLATE_LIST } from './theme.ts';
import type { Plan, Theme } from './domain.ts';
import { translator, type Key } from './i18n.ts';

const CUSTOM_ID = 'tr-custom';
const DATA_FROM = 'tr-marco'; // the preview reuses a full calendar, clients and shop
const t = translator('it');

function go(path: string) {
  const url = new URL(location.href);
  url.pathname = path;
  history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function DemoPanel({ api, current, onPick, onChange }: { api: DemoApi; current: string; onPick(slug: string): void; onChange(): void }) {
  const [, rerender] = useState(0);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 959px)').matches);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const m = matchMedia('(max-width: 959px)');
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);

  const db = api.db();
  const cur = db.trainers.find((x) => x.slug === current) ?? db.trainers[0];
  const custom = db.trainers.find((x) => x.id === CUSTOM_ID);
  const actor = api.actor();
  const view = actor === cur.ownerUserId ? 'trainer' : actor === null ? 'invite' : 'client';
  const changed = () => {
    rerender((n) => n + 1);
    onChange();
  };

  function pick(slug: string) {
    api.setActor(DEMO_USER);
    onPick(slug);
    go('/');
    changed();
  }

  function setView(v: 'client' | 'trainer' | 'invite') {
    if (v === 'client') {
      api.setActor(DEMO_USER);
      go('/');
    } else if (v === 'trainer') {
      api.setActor(cur.ownerUserId);
      go('/admin');
    } else {
      const code = db.clients.find((c) => c.trainerId === cur.id && c.userId === DEMO_USER)?.referralCode ?? '';
      api.setActor(null);
      go(`/r/${code}`);
    }
    changed();
  }

  function edit(patch: Partial<Omit<DemoTrainer, 'theme'>> & { theme?: Partial<Theme> }) {
    const base: DemoTrainer = custom ?? {
      ...db.trainers.find((x) => x.id === DATA_FROM)!,
      id: CUSTOM_ID,
      slug: 'il-tuo-brand',
      ownerUserId: 'owner-custom',
      name: 'Il tuo nome',
      tagline: 'Il tuo stile, i tuoi clienti, la tua app.',
      template: 'studio',
      plan: 'pro',
      theme: { brand: '#E4572E', accent: '#FFB38A', mode: 'auto', cover: PHOTOS.rack },
    };
    const next: DemoTrainer = { ...base, ...patch, theme: { ...base.theme, ...patch.theme } };
    if (custom) api.upsertTrainer(next);
    else api.cloneTrainer(DATA_FROM, next);
    if (current !== next.slug) {
      api.setActor(DEMO_USER);
      onPick(next.slug);
    }
    changed();
  }

  function onLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/') || file.size > 600_000) return;
    const reader = new FileReader();
    reader.onload = () => edit({ theme: { logo: String(reader.result) } });
    reader.readAsDataURL(file);
  }

  async function copyTheme() {
    const src = custom ?? cur;
    const json = JSON.stringify(
      { slug: src.slug, name: src.name, tagline: src.tagline, template: src.template, plan: src.plan, theme: { ...src.theme, logo: src.theme.logo?.startsWith('https://') ? src.theme.logo : undefined } },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      console.warn('clipboard', err);
    }
  }

  const editing = custom && cur.id === CUSTOM_ID ? custom : null;
  const panel = (
    <aside className="panel" aria-label={t('demo.title')}>
      <div className="row">
        <h1>{t('demo.title')}</h1>
        <span className="spacer" />
        {narrow && (
          <button className="panel-btn" onClick={() => setOpen(false)} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        )}
      </div>
      <p>{t('demo.lead')}</p>

      <h2>{t('demo.trainers')}</h2>
      {db.trainers.map((x) => (
        <button key={x.id} className="trainer-pick" aria-pressed={x.id === cur.id} onClick={() => pick(x.slug)}>
          <span className="swatch" style={{ background: x.theme.brand }} aria-hidden />
          <span>
            {x.name}
            <small>
              {TEMPLATE_LIST.find((s) => s.id === x.template)?.label}, {t(`plan.${x.plan}` as Key)}
            </small>
          </span>
          <Eye size={18} aria-hidden />
        </button>
      ))}

      <h2>{t('demo.view')}</h2>
      <div className="panel-row">
        {(['client', 'trainer', 'invite'] as const).map((v) => (
          <button key={v} className="panel-btn" aria-pressed={view === v} onClick={() => setView(v)}>
            {v === 'client' ? t('demo.client') : v === 'trainer' ? t('demo.trainer') : t('demo.invite')}
          </button>
        ))}
      </div>

      <h2>{t('demo.create')}</h2>
      {!editing ? (
        <button className="panel-btn" onClick={() => edit({})}>
          <Palette size={16} aria-hidden /> {t('demo.create')}
        </button>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <label className="field">
            <span className="field-label">{t('demo.name')}</span>
            <input className="input" value={editing.name} maxLength={40} onChange={(e) => edit({ name: e.target.value || ' ' })} />
          </label>
          <label className="field">
            <span className="field-label">{t('demo.tagline')}</span>
            <input className="input" value={editing.tagline} maxLength={120} onChange={(e) => edit({ tagline: e.target.value })} />
          </label>
          <div className="field">
            <span className="field-label">{t('demo.look')}</span>
            <div className="looks">
              {TEMPLATE_LIST.map((s) => {
                const n = s.defaultMode === 'dark' ? s.dark : s.light;
                return (
                  <button key={s.id} className="look" aria-pressed={editing.template === s.id} onClick={() => edit({ template: s.id, theme: { mode: s.defaultMode } })}>
                    <span
                      className="look-preview"
                      style={{
                        background: n.bg,
                        color: n.ink,
                        fontFamily: s.fontDisplay,
                        fontWeight: s.display.weight,
                        fontStyle: s.display.style,
                        textTransform: s.display.transform,
                        borderRadius: s.radius.card === '6px' ? 4 : 10,
                        boxShadow: `inset 0 -6px 0 ${editing.theme.brand}`,
                      }}
                    >
                      Aa
                    </span>
                    {s.label}
                  </button>
                );
              })}
            </div>
            <span className="field-hint" style={{ color: '#8b8f99' }}>
              {TEMPLATE_LIST.find((s) => s.id === editing.template)?.description.it}
            </span>
          </div>
          <div className="colors">
            <label className="color-input">
              <input type="color" value={editing.theme.brand} onChange={(e) => edit({ theme: { brand: e.target.value.toUpperCase() } })} />
              <span>{t('demo.brand')}</span>
            </label>
            <label className="color-input">
              <input type="color" value={editing.theme.accent ?? editing.theme.brand} onChange={(e) => edit({ theme: { accent: e.target.value.toUpperCase() } })} />
              <span>{t('demo.accent')}</span>
            </label>
          </div>
          <div className="field">
            <span className="field-label">{t('demo.cover')}</span>
            <div className="covers">
              {COVER_CHOICES.map((src) => (
                <button key={src} className="cover" aria-pressed={editing.theme.cover === src} onClick={() => edit({ theme: { cover: src } })}>
                  <img src={src.replace('w=1400', 'w=160')} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
          <div className="panel-row">
            <label className="panel-btn" style={{ cursor: 'pointer' }}>
              <UploadSimple size={16} aria-hidden /> {t('demo.upload')}
              <input type="file" accept="image/*" className="sr-only" onChange={onLogo} />
            </label>
            {editing.theme.logo && (
              <button className="panel-btn" onClick={() => edit({ theme: { logo: undefined } })}>
                <X size={16} aria-hidden /> {t('demo.logo')}
              </button>
            )}
          </div>
          <div className="field">
            <span className="field-label">{t('demo.plan')}</span>
            <div className="panel-row">
              {(['web', 'pro', 'store'] as Plan[]).map((p) => (
                <button key={p} className="panel-btn" aria-pressed={editing.plan === p} onClick={() => edit({ plan: p })}>
                  {t(`plan.${p}` as Key)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <h2>&nbsp;</h2>
      <div className="panel-row">
        <button className="panel-btn" onClick={copyTheme}>
          <Copy size={16} aria-hidden /> {copied ? t('demo.copied') : t('demo.copyJson')}
        </button>
        <button
          className="panel-btn"
          onClick={() => {
            api.reset();
            pick('marco-bellini');
          }}
        >
          <ArrowCounterClockwise size={16} aria-hidden /> {t('demo.reset')}
        </button>
      </div>
    </aside>
  );

  if (!narrow) return panel;
  return (
    <>
      <button className="demo-fab" onClick={() => setOpen(true)}>
        {t('demo.open')}
      </button>
      {open && (
        <div className="demo-overlay" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          {panel}
        </div>
      )}
    </>
  );
}
