// A brand made in the demo lives in one browser's storage. It also travels in the link (?brand=),
// so the same link opened on a phone rebuilds the same brand instead of "this app doesn't exist".
import { isHexColor, isHttpsUrl, type Plan, type Theme } from './domain.ts';
import { TEMPLATE_LIST } from './theme.ts';
import type { DemoTrainer } from './seed.ts';

export type BrandPatch = Partial<Omit<DemoTrainer, 'theme'>> & { theme?: Partial<Theme> };

const PLANS: readonly Plan[] = ['web', 'pro', 'store'];

/** The brand as a URL-safe string: base64url of its JSON. An uploaded logo (a data: URL) is too big and stays out. */
export function brandParam(tr: Pick<DemoTrainer, 'name' | 'tagline' | 'template' | 'plan' | 'theme'>): string {
  const logo = tr.theme.logo && isHttpsUrl(tr.theme.logo) ? tr.theme.logo : undefined;
  const json = JSON.stringify({ name: tr.name, tagline: tr.tagline, template: tr.template, plan: tr.plan, theme: { ...tr.theme, logo } });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The brand from a ?brand= link, checked field by field: anything malformed means no brand. */
export function brandFromParam(param: string | null): BrandPatch | null {
  if (!param) return null;
  try {
    const bin = atob(param.replace(/-/g, '+').replace(/_/g, '/'));
    const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const th = (typeof o.theme === 'object' && o.theme !== null ? o.theme : {}) as Record<string, unknown>;
    const text = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : undefined);
    const url = (x: unknown) => (typeof x === 'string' && isHttpsUrl(x) ? x : undefined);
    const color = (x: unknown) => (typeof x === 'string' && isHexColor(x) ? x : undefined);
    const name = text(o.name, 40)?.trim();
    const template = TEMPLATE_LIST.find((s) => s.id === o.template)?.id;
    const plan = PLANS.find((p) => p === o.plan);
    const brand = color(th.brand);
    if (!name || !template || !plan || !brand) return null;
    const mode = th.mode === 'light' || th.mode === 'dark' ? th.mode : 'auto';
    return { name, tagline: text(o.tagline, 120) ?? '', template, plan, theme: { brand, accent: color(th.accent), mode, cover: url(th.cover), logo: url(th.logo) } };
  } catch {
    return null;
  }
}
