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

### Booking confirmations and reminders by email
- **What:** the sender that already exists for the waitlist alerts (see Done, "Automatic alerts") also emails booking confirmations and cancellations with the `.ics` attached, and reminders, for example 24 hours before.
- **Why:** in v1 nobody sends booking email. The client only gets "Add to calendar" right after booking. A calendar entry is not a reminder system (outside review #9). Late cancels and no-shows are the most common complaint in the research (16 of 29 sources).
- **Meanwhile:** the trainer's Oggi tab lists the sessions in the next 48 hours with a one-tap WhatsApp reminder already written (`src/screens/FollowUps.tsx`). It needs the trainer to tap; the server job removes that.
- **Left to build:** new `kind`s in the outbox and their text in `supabase/functions/notify/email.ts`; for reminders a pg_cron job that queues them (a `dedupe_key` like `reminder:<booking id>` makes it safe to run often); a trainer setting to switch them off.
- **Priority:** P1, before the second trainer.
- **Effort:** S to M: the queue, the sender, the minute job and the Resend setup already exist.
- **Depends on:** Resend set up (verified domain, API key), as for the waitlist alerts. The `.ics` builder exists: `icsEvent()` in `src/domain.ts`.

## P2

### Trainer notified of bookings and cancellations
- **What:** an email (later a push) to the trainer when a client books, cancels, or cancels late.
- **Why:** today the trainer sees changes only when they open the admin. A 7:00 cancel for an 8:00 session goes unnoticed.
- **Priority:** P2.
- **Effort:** S, once the confirmations exist.
- **Depends on:** the sender (see Done, "Automatic alerts"): a new `kind` in the outbox, and a trainer's email to write to (`owner_email`).

### Calendar feed of the trainer's bookings
- **What:** a private iCal URL per trainer (a secret token in the link) that Google Calendar or Apple Calendar subscribes to. Read only.
- **Why:** trainers live in their phone calendar. Seeing app bookings next to their private appointments prevents double booking (outside review #2). Google refreshes subscribed calendars only every few hours, so it is a view, not a lock. Two-way sync is much harder and not planned.
- **Priority:** P2.
- **Effort:** M.
- **Depends on:** an Edge Function that serves the feed, and a token column on `trainers`.

### Waitlist: hold the place for the first in line
- **What:** when a place opens, the first in line is told alone and the place is held for them for a short time (say 15 minutes). Then the next one, and so on.
- **Why:** today every client waiting is emailed at once (see Done, "Automatic alerts") and the first to tap gets the place; the others read about a place that is already gone. Fine for a small studio. A hold is fairer, and it spares the others a pointless alert.
- **Priority:** P3, when a trainer or their clients complain.
- **Effort:** M. An offer time on the entry, the hold inside `free_slots` and `book`, scenarios for it in both backends, and a minute job that moves on to the next client.

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

- **Automatic alerts.** When a booking is cancelled, every client waiting for that session gets an email: a place opened up, first to book gets it. The database queues one row per client (`app_private.outbox`, migration `20261001000000`); a minute job (`pg_cron` and `pg_net`) wakes the Edge Function `supabase/functions/notify`, which writes the email in the trainer's language and time zone and sends it through Resend, with the trainer's name as sender and their email as the reply address. It only goes out while the place is still free and bookable, expires after an hour, is sent at most once an hour per client and session, and is retried up to five times. A cancellation never waits for it and never fails because of it. Setup and checks: [docs/RUNBOOK.md](docs/RUNBOOK.md), "Automatic alerts".
- **Waitlist.** A full time shows as "Pieno" in the booking grid and a client can join its list (free, no session used). When a place opens they see it on Home, one tap to book, and in the Agenda; the trainer sees it in the Oggi tab under "Posti liberi da riempire", first in line first, with the WhatsApp message already written. The list holds nothing: whoever books first has the place. Whether a place is open and who is first is worked out when the list is read, so booking, cancelling and moving never touch it. SQL migration `20260930010000`, the same rules in `src/domain.ts`, six shared scenarios.
- **A preview that sells** (demo site). A trainer who opens a personal link picks look and colors, sees the monthly price (`src/offer.ts`, ends by itself on 4 October 2026, then list price) and taps "Voglio la mia app": the form on puntoduestudio.it arrives pre-filled. Our own tools moved behind `?studio=1`.
- **Follow-ups in the trainer's Oggi tab.** Sessions to remind in the next 48 hours, packs to renew (2 or fewer sessions left), clients quiet for 14+ days, each with a WhatsApp message already written (`src/followups.ts`, tested). Rows are marked "Scritto" on this device only: not shared between the trainer's devices.
- **Move a session** ("Sposta" in the Agenda): one atomic step, `reschedule_booking` in the database (migration `20260930000000`), allowed while a free cancellation still is.
- **Standing weekly slot**: a client books the same time for 2 or 4 weeks in one go. A full week is skipped; no credits stops it.
- **Month tab**: month switcher, a fair comparison (this month so far against the same days of the month before), sessions per week, and the month's pack payments as a CSV for the accountant.
- **CSV export in the trainer admin.** Clients with name, email, phone, sessions left and start date (`src/screens/Trainer.tsx`). Bookings, packs and the ledger are not in it: for those, use the SQL export in [docs/RUNBOOK.md](docs/RUNBOOK.md).
