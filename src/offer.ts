// The offer a trainer sees in the preview, in one place: the quote (Preventivo App Personal Trainer) and the
// contact list say the same numbers. After OFFER_END the list prices apply and the discount disappears.
import type { Plan } from './domain.ts';

/** Monthly price in euros, VAT excluded. No activation fee. */
export const LIST_PRICE: Record<Plan, number> = { web: 106, pro: 152, store: 198 };
export const OFFER_PRICE: Record<Plan, number> = { web: 69, pro: 99, store: 129 };
export const OFFER_DISCOUNT = 35;
/** The offer runs through Sunday 4 October 2026 (Rome time, still summer time then). */
export const OFFER_ENDS = Date.parse('2026-10-05T00:00:00+02:00');

/** Where "Voglio la mia app" leads: the form, with what the trainer chose in the preview. */
export const FORM_URL = 'https://puntoduestudio.it/modulo-trainer';
export const WHATSAPP = '393248423657';

export interface Price {
  price: number;
  /** The crossed-out list price, only while the offer runs. */
  was: number | null;
  /** Whole days left in the offer (1 on the last day), or null when it is over. */
  daysLeft: number | null;
}

export function monthlyPrice(plan: Plan, now = Date.now()): Price {
  if (now >= OFFER_ENDS) return { price: LIST_PRICE[plan], was: null, daysLeft: null };
  return { price: OFFER_PRICE[plan], was: LIST_PRICE[plan], daysLeft: Math.max(1, Math.ceil((OFFER_ENDS - now) / 86_400_000)) };
}

/** The form link for one preview: name, look, plan and the preview itself, so the form arrives half filled. */
export function formLink(brand: { name: string; template: string; plan: Plan; colors: string }, preview: string): string {
  const q = new URLSearchParams({ nome: brand.name.trim(), stile: brand.template, piano: brand.plan, colori: brand.colors, anteprima: preview });
  return `${FORM_URL}?${q}`;
}

export function whatsappLink(name: string): string {
  const text = `Ciao Manuel, ho visto l'anteprima della mia app «${name.trim()}» e vorrei attivarla.`;
  return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;
}
