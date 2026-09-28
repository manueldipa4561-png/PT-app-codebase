// The sales demo around the phone: switch trainer, switch client / trainer view, and build a
// trainer's brand live while they watch ("the list to choose from"). Demo mode only.
import { useEffect, useState, type ChangeEvent } from 'react';
import { ArrowCounterClockwise, Check, Copy, Palette, SlidersHorizontal, UploadSimple, X } from '@phosphor-icons/react';
import type { DemoApi } from './demo.ts';
import { COVER_CHOICES, DEMO_USER, PHOTOS, type DemoDB, type DemoTrainer } from './seed.ts';
import { TEMPLATE_LIST } from './theme.ts';
import type { Plan } from './domain.ts';
import { translator, type Key } from './i18n.ts';
import { CUSTOM_SLUG, brandParam, type BrandPatch } from './demoBrand.ts';

const CUSTOM_ID = 'tr-custom';
const DATA_FROM = 'tr-marco'; // the preview reuses a full calendar, clients and shop
const t = translator('it');

/** Creates or updates the demo's custom brand, a copy of Marco's calendar, clients and shop. */
export function saveCustomBrand(api: DemoApi, patch: BrandPatch): DemoTrainer {
  const db = api.db();
  const custom = db.trainers.find((x) => x.id === CUSTOM_ID);
  const base: DemoTrainer = custom ?? {
    ...db.trainers.find((x) => x.id === DATA_FROM)!,
    id: CUSTOM_ID,
    slug: CUSTOM_SLUG,
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
  return next;
}

/** Puts the custom brand in the address bar (?brand=), so the link opens it on any device. */
function syncBrandParam(tr: DemoTrainer) {
  const url = new URL(location.href);
  url.searchParams.set('brand', brandParam(tr));
  history.replaceState(history.state, '', url);
}

/**
 * The trainer as one app_private.onboard_trainer() call, ready for the Supabase SQL editor.
 * onboard_trainer refuses to run while any <<placeholder>> is left.
 */
function goLiveSql(db: DemoDB, src: DemoTrainer): string {
  const types = db.sessionTypes.filter((s) => s.trainerId === src.id && s.active).sort((a, b) => a.sort - b.sort);
  const typeName = new Map(types.map((s) => [s.id, s.name]));
  const trainer = {
    slug: src.id === CUSTOM_ID ? '<<slug, per esempio mario-rossi>>' : src.slug,
    name: src.name,
    tagline: src.tagline,
    template: src.template,
    plan: src.plan,
    theme: { ...src.theme, logo: src.theme.logo?.startsWith('https://') ? src.theme.logo : undefined },
    ownerEmail: '<<email con cui il trainer accede>>',
    whatsapp: src.whatsapp ?? '<<numero WhatsApp con prefisso, oppure togli questa riga>>',
    timezone: src.timezone,
    cancelWindowHours: src.cancelWindowHours,
    sessionTypes: types.map((s) => ({ name: s.name, description: s.description ?? undefined, minutes: s.minutes, capacity: s.capacity, credits: s.credits })),
    availability: db.availability
      .filter((a) => a.trainerId === src.id)
      .map((a) => ({ weekday: a.weekday, start: a.start, end: a.end, location: a.location ?? undefined, sessionType: a.sessionTypeId ? typeName.get(a.sessionTypeId) : undefined })),
    products:
      src.plan === 'web'
        ? []
        : db.products
            .filter((p) => p.trainerId === src.id && p.active)
            .sort((a, b) => a.sort - b.sort)
            .map((p) => ({ name: p.name, description: p.description ?? undefined, priceCents: p.priceCents, imageUrl: p.imageUrl ?? undefined, paymentUrl: '<<Stripe Payment Link del trainer>>' })),
  };
  return [
    '-- Go live for one trainer: paste into the Supabase SQL editor, replace every <<placeholder>>, run.',
    '-- Re-run the whole call to change anything later (see README, "Add a trainer").',
    'select app_private.onboard_trainer($json$',
    JSON.stringify(trainer, null, 2),
    '$json$::jsonb);',
    '',
  ].join('\n');
}

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
    if (custom && slug === custom.slug) syncBrandParam(custom);
    go('/');
    changed();
    setOpen(false); // on a phone, show the result right away
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
    setOpen(false);
  }

  function edit(patch: BrandPatch) {
    const next = saveCustomBrand(api, patch);
    if (current !== next.slug) {
      api.setActor(DEMO_USER);
      onPick(next.slug);
    }
    syncBrandParam(next); // every change keeps the link shareable
    changed();
  }

  function onLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/') || file.size > 600_000) return;
    const reader = new FileReader();
    reader.onload = () => edit({ theme: { logo: String(reader.result) } });
    reader.readAsDataURL(file);
  }

  async function copyGoLive() {
    try {
      await navigator.clipboard.writeText(goLiveSql(db, custom ?? cur));
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
          {x.id === cur.id && <Check size={18} weight="bold" aria-hidden />}
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

      <h2>{t('demo.brandTitle')}</h2>
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

      <div className="panel-row panel-foot">
        <button className="panel-btn" onClick={copyGoLive}>
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
      <button className="demo-fab" onClick={() => setOpen(true)} aria-label={t('demo.openLabel')} aria-expanded={open}>
        <SlidersHorizontal size={16} weight="bold" aria-hidden />
        {t('demo.open')}
      </button>
      {open && (
        <div className="demo-overlay" role="dialog" aria-modal="true" aria-label={t('demo.title')} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          {panel}
        </div>
      )}
    </>
  );
}
