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
- On desktop, a demo panel sits next to the phone-sized app (on a phone, a button opens it). Use it to:
  - switch trainer,
  - switch view: client, trainer (the admin at `/admin`), or a signed-out friend opening an invite link,
  - create a brand live: type a trainer's name, pick a look, colors, a cover photo, a logo and a plan,
  - copy the theme JSON. You use it when you onboard that trainer,
  - reset the demo data.

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

Do these once, in this order.

1. **Supabase project.** Create it in an **EU region** (for example Frankfurt). Move it to the Pro plan before the first paying trainer: Pro has daily backups, free projects have none and pause when idle.
2. **Custom SMTP.** Supabase's built-in email is for testing only. Open a Brevo account (EU, free up to 300 emails a day) and authenticate your sending domain there (Brevo gives you the DNS records). Then fill in Authentication > SMTP Settings in Supabase: host `smtp-relay.brevo.com`, port 587, your Brevo SMTP login and SMTP key.
3. **Email templates.** Clients sign in with a 6-digit code, not a link: a link opens Safari, not the home-screen app. In Authentication > Email Templates, edit both **Magic Link** and **Confirm signup**: remove `{{ .ConfirmationURL }}` and show the code with `{{ .Token }}`. Confirm signup matters because a first-time sign-in gets that template.
4. **Rate limits.** With custom SMTP, Supabase sends 30 emails an hour by default. Raise it in Authentication > Rate Limits, or one busy launch day runs out.
5. **Database.** Apply the migration with the Supabase CLI. No Docker needed.
   ```
   npx supabase init
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
   `init` runs once: it adds `supabase/config.toml` (answer N to its questions, then commit the file). The project ref is the part before `.supabase.co` in the project URL. `link` asks for the database password you chose when you created the project.
6. **Netlify environment variables** (Site configuration > Environment variables). The values are in the Supabase dashboard, Project Settings.
   - `VITE_SUPABASE_URL`: the project URL
   - `VITE_SUPABASE_ANON_KEY`: the anon (public) key
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY`: the same two values, read on the server by the edge function
   - `VITE_APP_BASE_DOMAIN` (optional): the domain whose subdomains are trainer slugs, for example `app.example.it`

   The service_role key never goes into Netlify, the repo or the frontend.
7. **Deploy.** Push to the main branch, or start a deploy in Netlify. `VITE_` variables are baked in at build time: after changing one, deploy again.

From now on, database changes go out before the frontend. See [docs/RUNBOOK.md](docs/RUNBOOK.md), "Deploy order".

## Add a trainer

The full onboarding checklist (under an hour) is in [docs/RUNBOOK.md](docs/RUNBOOK.md). This is the database part. Run it in the Supabase SQL editor and replace `mario-rossi` with the trainer's slug.

**1. The trainer row.** Build their look in the demo panel and copy the theme JSON: it holds the slug, name, tagline, template, plan and theme. Two things to replace in the theme: the logo (an uploaded logo stays in the browser and is left out) and the cover (a demo photo). Upload the trainer's own logo and cover to a public Supabase Storage bucket (for example `brand`) and use those URLs. The database accepts `https://` URLs only.

```sql
insert into public.trainers (slug, name, tagline, template, theme, plan, whatsapp, instagram)
values (
  'mario-rossi',
  'Mario Rossi PT',
  'Personal training a Bologna.',
  'energy',
  '{"brand": "#CBF24A", "accent": "#FF6A2B", "mode": "dark",
    "logo": "https://<ref>.supabase.co/storage/v1/object/public/brand/mario-logo.png",
    "cover": "https://<ref>.supabase.co/storage/v1/object/public/brand/mario-cover.jpg"}',
  'web',
  '393331234567',
  'https://instagram.com/mariorossipt'
);
```

- `slug`: lowercase letters, digits and hyphens. It is the subdomain and the `?t=` key.
- `template`: `studio`, `energy` or `luxe`. `plan`: `web`, `pro` or `store`. `whatsapp`: digits only, with the country code.
- Everything else has a default: time zone Europe/Rome, 30-minute slot steps, 2 hours minimum notice, bookings up to 28 days ahead, a 24-hour cancellation window, 1 bonus session each for referrals. Change any of them later with an `update`.

**2. Session types.** `credits` is what one booking costs (0 = free). `capacity` above 1 makes it a small group. Keep names neutral, with no health data: "Personal 1:1" yes, "Post-injury rehab" no.

```sql
with t as (select id from public.trainers where slug = 'mario-rossi')
insert into public.session_types (trainer_id, name, description, minutes, capacity, credits, sort)
select t.id, v.* from t, (values
  ('Personal 1:1',         'Programma su misura.',             60, 1, 1, 0),
  ('Small group',          'Fino a quattro persone.',          60, 4, 1, 1),
  ('Valutazione iniziale', 'Test di partenza e obiettivi.',    45, 1, 0, 2)
) as v(name, description, minutes, capacity, credits, sort);
```

**3. Availability.** One row per weekly window, in the trainer's local time. `weekday` is ISO: **1 = Monday**, 7 = Sunday. The `::time` on the first row sets the type for the whole list.

```sql
with t as (select id from public.trainers where slug = 'mario-rossi')
insert into public.availability (trainer_id, weekday, start_time, end_time, location)
select t.id, v.* from t, (values
  (1, '07:00'::time, '10:00'::time, 'Palestra Centro'),
  (1, '17:00',       '21:00',       'Palestra Centro'),
  (3, '17:00',       '21:00',       'Palestra Centro'),
  (6, '09:00',       '12:00',       'Parco della Montagnola')
) as v(weekday, start_time, end_time, location);
```

To keep a window for one session type only (a group class), also fill its `session_type_id`.

**4. Products (pro and store plans only).** Each "Buy" button opens a Stripe Payment Link that the trainer creates in their own Stripe account.

```sql
insert into public.products (trainer_id, name, description, price_cents, payment_url, sort)
select id, 'Kit elastici', 'Ritiro alla prossima sessione.', 2490, 'https://buy.stripe.com/<link>', 0
from public.trainers where slug = 'mario-rossi';
```

**5. Point the domain.** Pick the final one now: moving a trainer to another domain later signs every client out, and they must reinstall.

- **Subdomain** (day 1, no DNS work for the trainer): in Netlify, Domain management > Add a domain alias: `mario-rossi.<VITE_APP_BASE_DOMAIN>`. If that domain's DNS is not on Netlify, add a CNAME record `mario-rossi` pointing to `<your-site>.netlify.app`.
- **Their own domain**: the trainer adds a CNAME `app` pointing to `<your-site>.netlify.app` at their DNS provider. Add `app.mariorossi.it` as a domain alias in Netlify, then:

```sql
update public.trainers set domain = 'app.mariorossi.it' where slug = 'mario-rossi';
```

**6. Make the trainer the owner.** The trainer opens their app and signs in once with the email code. They stop at the join form (they are the trainer, not a client). Then:

```sql
update public.trainers
set owner_user_id = (select id from auth.users where lower(email) = lower('mario@example.com'))
where slug = 'mario-rossi';
```

They open `https://<their app>/admin` and see the trainer admin. Send them that link.

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
