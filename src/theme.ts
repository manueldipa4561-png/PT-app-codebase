// "The list": the looks a trainer chooses from. One layout, three token sets.
// Direction comes from Awwwards 2025-26 fitness and yoga references (docs/DESIGN.md):
//   studio  clean light, electric cobalt           (Malta Personal Trainer)
//   energy  monochrome + one hot accent, condensed (Essor Fitness, Fit and You)
//   luxe    deep teal on cool bone, lowercase serif (Core Atelier Pilates, YOGAMAYA)
// Each template locks one shape system; the trainer's brand color sits on top.
import type { TemplateId, Theme } from './domain.ts';

interface Neutrals {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  muted: string;
  line: string;
}

export interface TemplateSpec {
  id: TemplateId;
  label: string;
  description: { it: string; en: string };
  defaultMode: 'light' | 'dark' | 'auto';
  light: Neutrals;
  dark: Neutrals;
  fontDisplay: string;
  fontBody: string;
  // shape lock: cards / buttons and chips / photos
  radius: { card: string; control: string; media: string };
  display: { weight: number; tracking: string; transform: 'none' | 'uppercase' | 'lowercase'; style: 'normal' | 'italic'; leading: number };
  // uniforms for the WebGL hero (src/HeroGL.tsx)
  shader: { mode: 0 | 1 | 2; speed: number; grain: number; strength: number };
  sample: Theme;
}

const GEIST = "'Geist Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export const TEMPLATES: Record<TemplateId, TemplateSpec> = {
  studio: {
    id: 'studio',
    label: 'Studio',
    description: { it: 'Pulito e luminoso. Un colore deciso su bianco.', en: 'Clean and bright. One bold color on white.' },
    defaultMode: 'auto',
    light: { bg: '#F3F5F9', surface: '#FFFFFF', surface2: '#E9EDF4', ink: '#0A1330', muted: '#56607A', line: '#DAE0EA' },
    dark: { bg: '#070B18', surface: '#0F1529', surface2: '#172039', ink: '#EEF2FA', muted: '#9CA7C0', line: '#242E4A' },
    fontDisplay: GEIST,
    fontBody: GEIST,
    radius: { card: '20px', control: '999px', media: '20px' },
    display: { weight: 680, tracking: '-0.035em', transform: 'none', style: 'normal', leading: 1.02 },
    shader: { mode: 1, speed: 0.35, grain: 0.035, strength: 0.6 },
    sample: { brand: '#1F4BFF', accent: '#7AA2FF' },
  },
  energy: {
    id: 'energy',
    label: 'Energy',
    description: { it: 'Nero, un solo colore acceso, titoli condensati.', en: 'Black, one hot color, condensed headlines.' },
    defaultMode: 'dark',
    light: { bg: '#F1F1EE', surface: '#FFFFFF', surface2: '#E6E6E1', ink: '#0B0B0C', muted: '#56564F', line: '#D6D6D0' },
    dark: { bg: '#0B0B0C', surface: '#141416', surface2: '#1D1D20', ink: '#F4F4F2', muted: '#A3A39E', line: '#2A2A2E' },
    fontDisplay: "'Barlow Condensed', 'Arial Narrow', sans-serif",
    fontBody: "'Barlow', ui-sans-serif, system-ui, sans-serif",
    radius: { card: '6px', control: '6px', media: '6px' },
    display: { weight: 800, tracking: '-0.01em', transform: 'uppercase', style: 'italic', leading: 0.95 },
    shader: { mode: 0, speed: 0.6, grain: 0.07, strength: 1 },
    sample: { brand: '#CBF24A', accent: '#FF6A2B' },
  },
  luxe: {
    id: 'luxe',
    label: 'Luxe',
    description: { it: 'Calmo e sartoriale. Serif minuscolo, forme ad arco.', en: 'Calm and tailored. Lowercase serif, arched shapes.' },
    defaultMode: 'auto',
    light: { bg: '#ECEFEA', surface: '#F7F9F5', surface2: '#E0E6DF', ink: '#0E2626', muted: '#526462', line: '#D2DAD2' },
    dark: { bg: '#081615', surface: '#0F2120', surface2: '#162C2B', ink: '#E8EEEA', muted: '#9CB0AB', line: '#223937' },
    // A serif is justified here: boutique pilates and yoga, as in the Core Atelier reference.
    fontDisplay: "'Cormorant Garamond', 'Iowan Old Style', Georgia, serif",
    fontBody: GEIST,
    radius: { card: '28px', control: '999px', media: '999px 999px 28px 28px' },
    display: { weight: 500, tracking: '-0.015em', transform: 'lowercase', style: 'normal', leading: 1.1 },
    shader: { mode: 2, speed: 0.22, grain: 0.05, strength: 0.55 },
    sample: { brand: '#0F4C4A', accent: '#D8C3A0' },
  },
};

export const TEMPLATE_LIST: TemplateSpec[] = [TEMPLATES.studio, TEMPLATES.energy, TEMPLATES.luxe];

// ── color math (WCAG 2.x relative luminance) ─────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: number) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0');
export const rgbToHex = (r: number, g: number, b: number) => `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Text color for a filled brand surface: whichever of the two inks contrasts more. */
export function readableOn(bg: string, dark = '#0B0B0C', light = '#FFFFFF'): string {
  return contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light;
}

/** The brand color used AS text on the page background, nudged toward ink until it reaches 4.5:1. */
export function brandTextOn(brand: string, bg: string, ink: string): string {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = t === 0 ? brand : mix(brand, ink, t);
    if (contrastRatio(c, bg) >= 4.5) return c;
  }
  return ink;
}

export function isDark(spec: TemplateSpec, theme: Theme, systemDark: boolean): boolean {
  const mode = theme.mode ?? spec.defaultMode;
  return mode === 'dark' || (mode === 'auto' && systemDark);
}

/** CSS custom properties for one trainer's app. Applied to the app root, never to :root. */
export function themeVars(spec: TemplateSpec, theme: Theme, dark: boolean): Record<string, string> {
  const n = dark ? spec.dark : spec.light;
  const brand = theme.brand;
  return {
    '--bg': n.bg,
    '--surface': n.surface,
    '--surface-2': n.surface2,
    '--ink': n.ink,
    '--muted': n.muted,
    '--line': n.line,
    '--brand': brand,
    '--on-brand': readableOn(brand),
    '--brand-text': brandTextOn(brand, n.bg, n.ink),
    '--brand-soft': mix(n.surface, brand, dark ? 0.2 : 0.12),
    '--accent': theme.accent ?? brand,
    '--font-display': spec.fontDisplay,
    '--font-body': spec.fontBody,
    '--r-card': spec.radius.card,
    '--r-control': spec.radius.control,
    '--r-media': spec.radius.media,
    '--display-weight': String(spec.display.weight),
    '--display-tracking': spec.display.tracking,
    '--display-transform': spec.display.transform,
    '--display-style': spec.display.style,
    '--display-leading': String(spec.display.leading),
    colorScheme: dark ? 'dark' : 'light',
  };
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}
