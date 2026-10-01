# PT App

One codebase, one branded app per personal trainer. Built by Punto Due Studio.

Every trainer gets their own app, with their name, logo and colors. Clients book sessions, see how many sessions are left in their pack, and invite friends for a bonus session. The trainer gets an admin: today's schedule, clients and balances, "pack paid", referrals.

A trainer is a database row, never a code fork. Their look is chosen from a list of three: **Studio**, **Energy** and **Luxe** (see [docs/DESIGN.md](docs/DESIGN.md)).

![Demo](docs/demo.png)

## Quick start

You need Node 24 (it runs the TypeScript tests without a build step).

```
npm install
npm run dev
```

Open http://localhost:5173/?t=marco-bellini

The other demo trainers:

| URL | Look | Plan |
|---|---|---|
| `?t=marco-bellini` | Energy | store |
| `?t=giulia-ferri` | Luxe | pro (has the shop) |
| `?t=luca-moretti` | Studio | web (no shop) |

## Demo mode

With no environment variables, the app runs in demo mode: the whole backend runs in your browser (`src/demo.ts`). No server, no cost. The free Netlify demo runs exactly this.

- The data is three invented trainers with about a month of bookings, packs and referrals, generated around today (`src/seed.ts`).
- You start signed in as Sara Conti, a client. At sign-in, any 6-digit code works.
- Changes are saved in the browser (localStorage key `pt-demo`) and reset every 12 hours. In private browsing they live in memory and reset on reload.
- On desktop, a panel sits next to the phone-sized app (on a phone, a button opens it). It has two faces:
  - **The preview a trainer sees** (the default, and what a personal preview link opens): "Personalizza". The trainer switches between what their clients see, how they run it and the invite page, picks a look and colors for their own app, sees the monthly price (the offer, then the list price, from `src/offer.ts`) and taps "Voglio la mia app", which opens the form on puntoduestudio.it pre-filled with their choices and the preview link, or WhatsApp to Manuel. It does not show our internal tools.
  - **Our tools**, with `?studio=1` on the address (it stays for the tab; `?studio=0` turns it off). Use it to:
    - switch trainer,
    - switch view: client, trainer (the admin at `/admin`), or a signed-out friend opening an invite link,
    - create a brand live: type a trainer's name, pick a look, colors, a cover photo, a logo and a plan,
    - copy the go-live SQL: one statement that creates that trainer in Supabase ("Add a trainer" below),
    - reset the demo data.
- A preview link for one person is `/?t=il-tuo-brand&brand=<base64url of the brand JSON>` (see `src/demoBrand.ts`): their name, their town, a look that fits. The contact list for outreach builds one per person.

Demo mode turns off as soon as `VITE_SUPABASE_URL` is set. To run locally against a real project, copy `.env.example` to `.env` and fill in the two `VITE_SUPABASE_` values.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on http://localhost:5173 |
| `npm run build` | Type check, then production build into `dist/` |
| `npm run preview` | Serves `dist/` locally, to check a build |
| `npm run typecheck` | TypeScript check only |
| `npm test` | The business rules, plus the shared scenarios against the demo backend |
| `npm run test:sql` | The same scenarios against the real migration, in PGlite (Postgres in WASM, no Docker) |
| `npm run test:api` | The production data source (`src/supabase.ts`, through supabase-js) against a local stand-in for Supabase's Auth and Data API running the real migration: the scenarios plus every Api method |

## Project map

| Path | What lives there |
|---|---|
| `src/domain.ts` | The business rules as pure functions: free slots, cancellations, balances, "this month" stats, calendar files. Also the types and the error codes. |
| `src/demo.ts`, `src/seed.ts` | The demo backend (runs in the browser) and its seeded data |
| `src/DemoPanel.tsx` | The demo panel next to the phone (demo mode only) |
| `src/App.tsx` | Routing: `/`, `/book`, `/agenda`, `/refer`, `/shop`, `/profile`, `/admin` (trainer only), `/r/<CODE>` (invite link) |
| `src/supabase.ts` | The production backend: calls the SQL functions on Supabase |
| `src/api.ts` | The one interface both backends implement, and which trainer this app is (below) |
| `src/theme.ts` | The three looks: colors, fonts, corner radii, hero shader settings, contrast math |
| `src/screens/*` | The screens, client side and trainer side |
| `src/HeroGL.tsx` | The WebGL hero, tinted with the trainer's brand color |
| `supabase/migrations/` | Tables, row level security and the SQL functions. In production, the rules live here. |
| `netlify/edge-functions/tenant-head.ts` | Puts each trainer's title, icons, manifest and WhatsApp preview into the page head |
| `tests/` | `scenarios.ts` is one list of business cases, run against both backends by `demo.test.ts` and `sql.test.ts` |

The rules exist twice: in SQL (production) and in TypeScript (demo). When you change a rule, change both and add a case to `tests/scenarios.ts`. The tests fail if the two disagree.

**Which trainer is this app?** `trainerKey()` in `src/api.ts` checks, in this order:

1. `VITE_TRAINER`, baked in at build time (store apps have no hostname)
2. `?t=<slug>` in the URL (demo and local development)
3. `<slug>.<VITE_APP_BASE_DOMAIN>`, for example `mario-rossi.app.example.it`
4. the hostname itself, for a trainer's own domain, for example `app.mariorossi.it`

## Go live

Everything in the code is ready: the only thing left is the Supabase project and its settings. Do these once, in this order (about 45 minutes).

1. **Supabase project.** Create it at supabase.com in an **EU region** (for example Frankfurt). Save the database password. Move to the Pro plan before the first paying trainer: Pro has daily backups, free projects have none and pause when idle.
2. **Database.** Pick one way:
   - **SQL editor (simplest):** open `supabase/migrations/20260928000000_init.sql` in this repo, copy all of it, paste it into Supabase > SQL Editor > New query, and click Run. It should end with "Success. No rows returned".
   - **CLI:** `npx supabase init` (once, answer N to its questions, commit `supabase/config.toml`), `npx supabase login`, `npx supabase link --project-ref <project-ref>`, `npx supabase db push`. The project ref is the part before `.supabase.co` in the project URL.
3. **Authentication > Sign In / Providers > Email.** Keep **Email** enabled, **Allow new users to sign up** on, and **Confirm email on** (the default). Confirm email is required: a trainer becomes the owner of their admin, and a client takes over the record their trainer created, only through a confirmed email. Keep the **email OTP length at 6** digits (the app's code field has 6).
4. **Custom SMTP.** Supabase's built-in email is for testing only (a few emails an hour, and only to your own team). Use Resend (free up to 100 emails a day): add your sending domain there with the **Ireland** region and put its three DNS records at your DNS provider (skip the "Receiving" MX record: it would take over your mailbox). Once the domain is verified, Resend > Settings > Integrations > **Supabase** > Connect: pick the project and a sender like `accesso@<your-domain>`. It creates the key and fills in Authentication > Emails > SMTP Settings for you.
5. **Email templates** (Authentication > Emails > Templates). Clients sign in with a 6-digit code, not a link: a link opens the browser, not the home-screen app. Replace the body of both **Magic Link** and **Confirm signup** with this (a first-time sign-in gets Confirm signup):
   ```html
   <h2>Il tuo codice di accesso</h2>
   <p>Scrivi questo codice nell'app per entrare:</p>
   <p style="font-size:32px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
   <p>Vale per un'ora. Se non l'hai chiesto tu, ignora questa email.</p>
   ```
   Subject for both: `Il tuo codice di accesso`.
6. **Rate limits** (Authentication > Rate Limits). With custom SMTP, Supabase sends 30 emails an hour by default. Raise it (for example 100), or one busy launch day runs out.
7. **Netlify environment variables** (Site configuration > Environment variables). The values are in Supabase > Project Settings > API Keys and Data API.
   - `VITE_SUPABASE_URL` and `SUPABASE_URL`: the project URL, `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` and `SUPABASE_ANON_KEY`: the public key, either the **publishable** key (`sb_publishable_...`) or the legacy **anon** key. Both work.
   - `VITE_APP_BASE_DOMAIN` and `APP_BASE_DOMAIN` (optional): the domain whose subdomains are trainer slugs, for example `app.example.it`

   Connected with Netlify's **Supabase extension** instead? Choose **Vite** as the framework: the names it sets (`SUPABASE_DATABASE_URL`, `SUPABASE_ANON_KEY` and their `VITE_` copies) work too, and so does `SUPABASE_PUBLISHABLE_KEY`. The extension also adds `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET`: delete both, the app never uses them.

   The secret / service_role key never goes into Netlify, the repo or the frontend.
8. **Deploy.** Push to the main branch, or start a deploy in Netlify. `VITE_` variables are baked in at build time: after changing one, deploy again. With these variables set the demo turns off: the site serves real trainers only. To keep the sales demo online, create a second Netlify site from the same repo with **no** environment variables.
9. **First trainer and smoke test.** Add a trainer (next section). To try it before any real domain, put your Netlify address in the JSON (`"domain": "<your-site>.netlify.app"`) and run it. Then, on a phone: open the site, sign in with a real email (the code must arrive, not in spam), join, and book. Open `/admin` signed in with the trainer's email: you see the trainer admin. Mark a pack paid and watch the client's balance change.

From now on, database changes go out before the frontend. See [docs/RUNBOOK.md](docs/RUNBOOK.md), "Deploy order".

## Add a trainer

One SQL statement creates a trainer with everything their app needs. The full onboarding checklist (under an hour) is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

**1. Build it in the demo.** Open the demo with `?studio=1`. With the trainer, create their brand in the panel (name, look, colors, cover, logo, plan), or pick the sample trainer closest to them. Click **Copia SQL di attivazione**. You get a statement like this:

```sql
select app_private.onboard_trainer($json$
{
  "slug": "mario-rossi",
  "name": "Mario Rossi PT",
  "tagline": "Personal training a Bologna.",
  "template": "energy",
  "plan": "pro",
  "theme": { "brand": "#CBF24A", "accent": "#FF6A2B", "mode": "dark",
             "logo": "https://<ref>.supabase.co/storage/v1/object/public/brand/mario-logo.png",
             "cover": "https://<ref>.supabase.co/storage/v1/object/public/brand/mario-cover.jpg" },
  "ownerEmail": "mario@example.com",
  "whatsapp": "+39 333 123 4567",
  "timezone": "Europe/Rome",
  "cancelWindowHours": 24,
  "sessionTypes": [
    { "name": "Personal 1:1", "description": "Programma su misura.", "minutes": 60, "capacity": 1, "credits": 1 },
    { "name": "Small group", "minutes": 60, "capacity": 4, "credits": 1 },
    { "name": "Valutazione iniziale", "minutes": 45, "capacity": 1, "credits": 0 }
  ],
  "availability": [
    { "weekday": 1, "start": "07:00", "end": "10:00", "location": "Palestra Centro" },
    { "weekday": 3, "start": "19:00", "end": "20:00", "location": "Palestra Centro", "sessionType": "Small group" }
  ],
  "products": [
    { "name": "Kit elastici", "priceCents": 2490, "paymentUrl": "https://buy.stripe.com/<link>" }
  ]
}
$json$::jsonb);
```

**2. Fill it in.** Replace every `<<placeholder>>` (the statement refuses to run while one is left) and adjust to the trainer's real week:
- `slug`: lowercase letters, digits and hyphens. It is their subdomain. `ownerEmail`: the email the trainer will sign in with.
- `logo` and `cover`: an uploaded logo stays in the browser and is left out, and the cover is a demo photo. Upload the trainer's own files in Supabase > Storage > **brand** (the migration creates this public bucket), click a file, "Get URL", and use those `https://` URLs. Product photos (`imageUrl`) go there too.
- `sessionTypes`: `credits` is what one booking costs (0 = free), `capacity` above 1 makes it a small group. Keep names free of health data: "Personal 1:1" yes, "Post-injury rehab" no.
- `availability`: one entry per weekly window, in the trainer's local time. `weekday` is ISO: **1 = Monday**, 7 = Sunday. `sessionType` (optional) keeps a window for one session type only, such as a group class.
- `products` (pro and store plans): each "Buy" opens a Stripe Payment Link the trainer creates in their own Stripe account. Use `[]` for none.
- Optional, with these defaults: `domain` (their own domain, see step 4), `instagram`, `locale` "it", `currency` "EUR", `slotStepMinutes` 30, `minNoticeHours` 2, `bookingHorizonDays` 28, `cancelWindowHours` 24, `bonusReferrer` 1, `bonusReferred` 1.

**3. Run it** in the Supabase SQL editor. The result shows what was saved, for example `{"owner": "links at the trainer's first sign-in", "session_types": 3, "availability_windows": 2, "products": 1}`. To change anything later, edit the JSON and run it again: it updates the trainer. Session types and products left out are retired, never deleted (past bookings keep them), and the weekly availability is replaced.

**4. Point the domain.** Pick the final one now: moving a trainer to another domain later signs every client out, and they must reinstall.
- **Subdomain** (day 1, no DNS work for the trainer): in Netlify, Domain management > Add a domain alias: `mario-rossi.<VITE_APP_BASE_DOMAIN>`. If that domain's DNS is not on Netlify, add a CNAME record `mario-rossi` pointing to `<your-site>.netlify.app`.
- **Their own domain**: the trainer adds a CNAME `app` pointing to `<your-site>.netlify.app` at their DNS provider. Add `app.mariorossi.it` as a domain alias in Netlify, put `"domain": "app.mariorossi.it"` in the JSON and run it again.

**5. The trainer signs in.** Send them `https://<their app>/admin`. They sign in with the email code, using the `ownerEmail` address, and land in their admin: the owner link is automatic, there is nothing to run.

## Before the first real client

- [ ] The trainer paid the first month. A "yes" without payment is interest, not demand.
- [ ] The SQL test suite ran against a disposable hosted Supabase project, not only PGlite ([TODOS.md](TODOS.md)).
- [ ] A staging Supabase project exists, and migrations run there first.
- [ ] A commercialista checked the referral rules against DPR 430/2001, especially the referrer's reward ([docs/GDPR.md](docs/GDPR.md)).
- [ ] The trainer signed the DPA (GDPR art. 28) and the terms.
- [ ] The trainer's privacy page and referral rules page are online.
- [ ] Supabase is on the Pro plan (daily backups).
- [ ] A login code arrived in a Gmail and an iCloud inbox, not in spam.
- [ ] On a real iPhone, in the home-screen app, "Add to calendar" opens the Calendar app.
- [ ] 5 real clients joined and booked without help while you watched. Every place they hesitated is the next fix.

## More docs

- [docs/STORE.md](docs/STORE.md): App Store and Google Play apps (store plan)
- [docs/RUNBOOK.md](docs/RUNBOOK.md): onboarding, offboarding, incidents, deploy order
- [docs/GDPR.md](docs/GDPR.md): roles, data, deletion, access requests, breaches
- [docs/DESIGN.md](docs/DESIGN.md): the three looks and where they come from
- [TODOS.md](TODOS.md): deferred work, with priorities
