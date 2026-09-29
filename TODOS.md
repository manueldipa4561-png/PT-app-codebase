# TODOS

Deferred work from the CEO review and the outside review (Codex). Each item says why it waits and what it waits for.

- **Priority.** P1: due before the milestone named on the item. P2: next, usually when a trainer asks or a plan is sold. P3: later, when its trigger happens.
- **Effort.** S: under a day. M: a few days. L: a week or more.

## P1

### Confirm on hosted Supabase what the local stand-in cannot
- **What:** `npm run test:api` already runs `src/supabase.ts` through supabase-js against a local stand-in for Supabase's Auth and Data API (`tests/fake-supabase.ts`) with the real migration. On the first real project, confirm by hand what the stand-in does not model: session refresh after an hour, the publishable (`sb_publishable_`) key, the Confirm signup and Magic Link emails showing the 6-digit code, `delete_my_account` removing the login (else the RUNBOOK warning path), the `link_owner` trigger on `auth.users` (the trainer lands in `/admin` after the first code), and two phones booking the last place at the same moment.
- **Why:** PGlite is Postgres, not Supabase: one connection (locks are never raced), a superuser `postgres`, and a partial `auth` schema.
- **Priority:** P1, before the first real client. The smoke test in README "Go live", step 9, covers most of it.
- **Effort:** S by hand. M to automate: a mode of `tests/supabase-api.test.ts` that points at a disposable project instead of the stand-in.
- **Depends on:** a throwaway Supabase project (the free plan is enough).

### Staging Supabase project
- **What:** a second Supabase project (EU) for staging. Netlify branch deploys point to it, with its own values for the environment variables in the branch deploy context.
- **Why:** today every migration goes straight to production. Demo mode stages the UI only, not the database.
- **Priority:** P1, before the first real client.
- **Effort:** S.
- **Depends on:** nothing.

### Server booking confirmations and reminders
- **What:** a Supabase Edge Function that emails booking confirmations, cancellations and reminders through Resend, with the `.ics` attached. A scheduled job (Supabase Cron) sends the reminders, for example 24 hours before.
- **Why:** in v1 nobody sends booking email. The client only gets "Add to calendar" right after booking. A calendar entry is not a reminder system (outside review #9).
- **Priority:** P1, before the second trainer.
- **Effort:** M.
- **Depends on:** Resend, already set up for the login codes. The `.ics` builder exists: `icsEvent()` in `src/domain.ts`.

## P2

### Trainer notified of bookings and cancellations
- **What:** an email (later a push) to the trainer when a client books, cancels, or cancels late.
- **Why:** today the trainer sees changes only when they open the admin. A 7:00 cancel for an 8:00 session goes unnoticed.
- **Priority:** P2.
- **Effort:** S, once the confirmations exist.
- **Depends on:** server booking confirmations.

### Calendar feed of the trainer's bookings
- **What:** a private iCal URL per trainer (a secret token in the link) that Google Calendar or Apple Calendar subscribes to. Read only.
- **Why:** trainers live in their phone calendar. Seeing app bookings next to their private appointments prevents double booking (outside review #2). Google refreshes subscribed calendars only every few hours, so it is a view, not a lock. Two-way sync is much harder and not planned.
- **Priority:** P2.
- **Effort:** M.
- **Depends on:** an Edge Function that serves the feed, and a token column on `trainers`.

### Waitlist that offers freed slots
- **What:** a client joins the waitlist of a full slot. When someone cancels, the first in line gets an offer with a short time to accept.
- **Why:** a refilled cancellation is money for the trainer (CEO review, deferred proposal #6).
- **Priority:** P2.
- **Effort:** M.
- **Depends on:** server notifications (email or push).

### Web Push for home-screen installs
- **What:** push notifications for reminders and waitlist offers in the installed web app. iPhone needs iOS 16.4 or later and the app added to the home screen.
- **Why:** faster and more visible than email, and free.
- **Priority:** P2.
- **Effort:** M.
- **Depends on:** the service worker (`public/sw.js`), VAPID keys, a table of push subscriptions, and the server sender from the confirmations item.

### Capacitor and Codemagic store pipeline
- **What:** wrap the web build with Capacitor and build one app per trainer: Android on Windows, iOS on Codemagic. One workflow per trainer.
- **Why:** the store plan sells App Store and Google Play apps in the trainer's name.
- **Priority:** P2, when the first store plan is sold. Not before.
- **Effort:** L for the first trainer (sold as paid discovery), then S per trainer.
- **Depends on:** a paying store trainer with their own Apple and Google accounts. Playbook: [docs/STORE.md](docs/STORE.md).

### Store review login
- **What:** a password login for one review account, used only by Apple and Google reviewers.
- **Why:** reviewers cannot receive our email codes. Without a working login the app is rejected.
- **Priority:** P2, store plan.
- **Effort:** S.
- **Depends on:** the store pipeline.

### push_tokens table and min_app_version check
- **What:** a `push_tokens` table for native push (APNs, FCM). A `min_app_version` value the app checks at start: below it, the app asks the client to update.
- **Why:** store apps update only when the client updates them, so old binaries keep calling the new backend. The version check is the way out when a change cannot stay compatible. It must be in the first store binary, or that binary can never be told.
- **Priority:** P2, store plan, part of the first store build.
- **Effort:** M.
- **Depends on:** the store pipeline.

## P3

### Sentry (EU)
- **What:** error reporting with Sentry's EU data region.
- **Why:** errors go to the browser console and the Netlify and Supabase logs only. Today we hear about bugs from trainers.
- **Priority:** P3, at 10 trainers.
- **Effort:** S.
- **Depends on:** adding Sentry to the subprocessor list in the DPA ([docs/GDPR.md](docs/GDPR.md)).

### Playwright smoke test of the booking flow
- **What:** one end-to-end test: open the demo, book a session, find it in the agenda, cancel it.
- **Why:** the rules are tested, the screens are not. Demo mode needs no backend, so the test runs in CI for free.
- **Priority:** P3.
- **Effort:** S.
- **Depends on:** screens that stopped changing every day.

### Online pack payments (Stripe, Satispay)
- **What:** the client pays a pack in the app, and the credits are added when the payment succeeds.
- **Why:** less "pack paid" work for the trainer, and no chasing payments.
- **Priority:** P3, when 3 or more trainers ask.
- **Effort:** L: webhooks, refunds, and the trainer's own Stripe account through Stripe Connect.
- **Depends on:** trainers asking. In store apps, in-person sessions may use Stripe (App Store 3.1.3(e)).

### Pack expiry
- **What:** packs expire after a set time, and unused credits leave the ledger with their own reason.
- **Why:** some trainers sell "10 sessions within 3 months".
- **Priority:** P3, when 2 or more trainers ask. Until then the trainer adjusts credits by hand.
- **Effort:** M. The rule goes in SQL and in TypeScript, plus scenarios.
- **Depends on:** trainers asking.

### Buffers between sessions and travel time between locations
- **What:** minutes kept free after each session, and extra time when the next session is at another location.
- **Why:** a trainer who moves between gyms cannot do back-to-back sessions (outside review #10).
- **Priority:** P3, when a trainer asks.
- **Effort:** M. The slot rules change in SQL and in TypeScript, plus scenarios.
- **Depends on:** nothing.

### WhatsApp reminders (pro plan)
- **What:** reminders over WhatsApp (Meta Cloud API, paid per message).
- **Why:** clients read WhatsApp, not email.
- **Priority:** P3.
- **Effort:** M.
- **Depends on:** server reminders and a WhatsApp Business setup.

### Live updates for store apps
- **What:** ship web changes to store apps without a store release (Capgo or Capawesome).
- **Why:** with many store trainers, batched store releases get slow.
- **Priority:** P3, at 5 or more store trainers.
- **Effort:** M.
- **Depends on:** the store pipeline and the min_app_version check.

### Shop with in-app orders
- **What:** Stripe Connect and Checkout, with the order status in the app.
- **Why:** v1 is a list of Payment Links, so the trainer cannot see orders in the app.
- **Priority:** P3, when trainers want orders tracked in the app.
- **Effort:** L.
- **Depends on:** the Stripe Connect work from online pack payments.

### Vertical-neutral engine
- **What:** the same engine (branded app, services, availability, packs, referrals) for other appointment businesses: salons, physios, studios.
- **Why:** Punto Due already has clients like these.
- **Priority:** P3, only when a second vertical pays. No abstraction before that.
- **Effort:** L.
- **Depends on:** a paying customer outside fitness.

### More than 100 trainers on one Netlify site
- **What:** move new trainers to a second Netlify site built from the same repo.
- **Why:** Netlify allows 100 domain aliases per site ([docs/RUNBOOK.md](docs/RUNBOOK.md), "Netlify facts").
- **Priority:** P3, at about 80 trainers.
- **Effort:** S.
- **Depends on:** nothing.

## Done

- **CSV export in the trainer admin.** Clients with name, email, phone, sessions left and start date (`src/screens/Trainer.tsx`). Bookings, packs and the ledger are not in it: for those, use the SQL export in [docs/RUNBOOK.md](docs/RUNBOOK.md).
