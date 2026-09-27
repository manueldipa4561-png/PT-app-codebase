# Design

The visual system behind the three looks, and where it came from. The exact tokens live in `src/theme.ts`. This file explains them.

## Research

Source: Awwwards, recent fitness, pilates and yoga winners. Godly now redirects to recent.design, which has no keyword search, so Awwwards was the source.

| Site | Award | What we noted |
|---|---|---|
| Core Atelier Pilates | Honorable Mention, Mar 2026 | full-bleed warm photography; a large lowercase serif headline bottom-left, with italic emphasis; minimal navigation; a personal greeting. Colors #F7E7DE and #25140C. |
| YOGAMAYA | Honorable Mention, May 2025 | #EBDCC2 and #0B2A2B; transitions; unusual navigation |
| Essor Fitness | Honorable Mention, Jan 2026 | black and white, video, transitions (built in Framer) |
| Fit and You | Honorable Mention, Nov 2023 | black plus one hot orange, #FF5300 |
| Malta Personal Trainer | Honorable Mention, Nov 2023 | electric blue #0544FF on deep navy #00113C |

## From the findings to the three looks

All three looks share one layout. Each has its own token set. The trainer picks a look, then sets a brand color, an accent (used by the hero shader only), light, dark or auto mode, a logo and a cover photo. The look locks the rest: fonts, headline style and the shape system (corner radii).

### Studio: cobalt on white

From Malta Personal Trainer: one electric blue on a clean light page.

- Light: background #F3F5F9, surface #FFFFFF, ink #0A1330, muted #56607A. Dark: background #070B18, ink #EEF2FA. Mode: follows the phone.
- Sample brand #1F4BFF (cobalt), accent #7AA2FF.
- Font: Geist for headlines and text. Headlines weight 680, tight tracking (-0.035em), line height 1.02.
- Shapes: cards 20px, buttons and chips fully round, photos 20px.
- Hero shader: calm (speed 0.35), light grain.

### Energy: monochrome plus one hot accent

From Essor Fitness (black and white) and Fit and You (black plus one hot color).

- Dark by default: background #0B0B0C, surface #141416, ink #F4F4F2. Light: background #F1F1EE.
- Sample brand #CBF24A (acid lime). Accent #FF6A2B, an orange close to Fit and You's #FF5300.
- Fonts: Barlow Condensed for headlines (weight 800, italic, uppercase, line height 0.95), Barlow for text.
- Shapes: 6px on everything. Hard edges, no pills.
- Hero shader: the fastest (speed 0.6), the most grain, full strength.

### Luxe: deep teal on cool bone

From Core Atelier Pilates (the lowercase serif headline, the calm) and YOGAMAYA (the deep teal #0B2A2B).

- Light: background #ECEFEA, surface #F7F9F5, ink #0E2626. Dark: background #081615, ink #E8EEEA. Mode: follows the phone.
- Sample brand #0F4C4A (deep teal). Accent #D8C3A0 (sand), inside the hero shader only.
- Fonts: Cormorant Garamond for headlines (weight 500, lowercase), Geist for text. A serif is justified here because boutique pilates and yoga studios use one, as the Core Atelier reference shows. The other two looks stay sans.
- Shapes: cards 28px, round buttons, photos as arches (round on top: `999px 999px 28px 28px`).
- Hero shader: the slowest (speed 0.22).
- **Beige and brass avoided on purpose.** A beige page with brass details reads as the generic wellness template. Luxe keeps the calm with teal and cool bone. The warm tone of Core Atelier survives only as the sand accent in the hero shader.

## How a look is applied

`themeVars()` in `src/theme.ts` turns the look and the trainer's theme into CSS variables: `--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--brand`, `--on-brand`, `--brand-text`, `--brand-soft`, `--accent`, the two fonts, three radii and the headline settings. They go on the app root, never on `:root`, so the demo can show a trainer's app next to the panel without restyling the page.

## Rules we follow

From the ui-ux-pro-max and taste-skill guidance:

- **One accent per app.** The trainer's brand color is the only strong color on screen.
- **Readable text on any brand color, computed, not eyeballed** (WCAG, at least 4.5:1):
  - Text on a brand-filled button: `readableOn()` picks near-black or white, whichever contrasts more.
  - The brand color used as text on the page: `brandTextOn()` mixes it toward the ink color until it reaches 4.5:1.
  - So a trainer can pick any color and the app stays readable. `tests/domain.test.ts` checks it.
- **44px touch targets**, at least.
- **Visible focus** on everything you can tap or tab to (`:focus-visible` in `src/styles.css`).
- **Reduced motion respected.** With the phone's "reduce motion" setting on, animations are reduced, the hero shows one still frame, and the card tilt and vibration are off.
- **Phosphor icons only** (`@phosphor-icons/react`). No emoji as icons.
- **Self-hosted fonts** (`@fontsource`). No requests to Google Fonts ([GDPR.md](GDPR.md)).
- **Motion only when it means something:** feedback (the tap worked), a state change (booked, cancelled), or hierarchy (where a screen came from). Never decoration.

## Interactions

What each interaction is for. The code is in `src/screens/`, `src/HeroGL.tsx` and `src/ui.tsx`.

- **WebGL hero.** A shader behind the trainer's name, tinted with their brand and accent colors, that reacts to touch. Each look sets its own mode, speed, grain and strength (`shader` in `src/theme.ts`). It pauses off screen and in background tabs.
- **Spring page transitions.** Screens arrive with a short spring (the `motion` package), so you feel where you went.
- **Booking confirm sheet.** A bottom sheet to confirm the slot. On success, a short animation and a haptic tick where the phone supports it.
- **Sessions-left ring.** The pack balance as a ring on the home screen, the number the client cares about most.
- **Holographic referral pass.** The client's invite code as a pass card with a sheen that tilts under the finger or the pointer.
- **Live brand preview (demo).** Type a trainer's name, pick a look, colors and a logo, and the phone next to the panel restyles at once. It is the sales tool: show a trainer their own app during the call.

## Adding a look

A bespoke look for one trainer becomes a new look on the list, so every trainer can use it:

1. Add its id to `TemplateId` in `src/domain.ts`, and its `TemplateSpec` to `TEMPLATES` and `TEMPLATE_LIST` in `src/theme.ts`.
2. Add a migration that widens the `template` check on `public.trainers`.
3. Add its fonts as `@fontsource` packages and import them in `src/main.tsx`.
4. Check the contrast in light and dark mode with the sample brand color.
