# GDPR

How the trainer apps handle personal data. This is Punto Due's working summary, not legal advice: the DPA and each trainer's privacy page are the documents that count.

## Roles

- **The trainer is the controller.** It is their business and their clients.
- **Punto Due is the processor** (GDPR art. 28). We run the app and the database on the trainer's instructions.
- **The DPA (data processing agreement) is signed before the trainer's first client joins,** together with our terms.
- Each trainer has a privacy page for their clients (the art. 13 notice), made from our template with their details.
- One login (an email address) can serve several trainer apps, because all trainers share one Supabase project. Each trainer controls only their own client records.

## What we store

| Data | Table | Why |
|---|---|---|
| Client: name, email, phone (optional) | `clients` | booking and contact |
| Referral code, who invited whom | `clients`, `referrals` | the referral program |
| Terms acceptance: date and version | `clients` | proof of acceptance |
| Bookings: time, session type, location, status, who booked | `bookings` | the service |
| Packs: credits, price, payment method, date, note | `pack_purchases` | accounting |
| Credit ledger: every plus and minus, with reason and note | `credit_ledger` | the balance, accounting |
| Blocked time, with an optional note | `time_off` | the trainer's calendar |
| Login: email, sign-up and sign-in times | `auth.users` (Supabase Auth) | the email code login |
| Trainer: name, contacts, look, booking rules | `trainers` | the app itself |
| App opens per day: a count, and how many came from the installed app. No user, IP or device | `app_visits` | the trainer's monthly numbers |

A client who invited a friend sees only the friend's first name and whether the reward was given.

**No health data in v1.** No injuries, weight, measurements or medical notes. This keeps GDPR art. 9 (special categories) out of scope. Watch the two places where it could slip in:
- **Session type names.** Keep them neutral. "Personal 1:1" or "Small group" is fine. "Post-injury rehab" is not: booking it says something about the client's health.
- **Free-text notes** (packs, manual adjustments, blocked time). Tell each trainer at handover not to write health information there.

## Legal basis

- **Contract** (art. 6(1)(b)): the client asks to book sessions and to track their pack.
- **Legal obligation** (art. 6(1)(c)): packs and the ledger support the trainer's accounting.

## Retention

- The data stays while the client is active, and after that for the accounting period the trainer's commercialista confirms (in Italy usually 10 years for accounting records, civil code art. 2220).
- On deletion the client record is **anonymized**. Bookings, packs and the ledger stay, linked to "Deleted client", for accounting.

## Deletion

**The client deletes their own account** in the app (Profile > delete account; Apple requires this too). The SQL function `delete_my_account`:
1. cancels the client's future bookings,
2. anonymizes the client row: the name becomes "Deleted client", email and phone are removed, and the row is unlinked from the login,
3. deletes the login only if no other trainer app uses it. If the database is not allowed to delete it, the function logs a warning: follow [RUNBOOK.md](RUNBOOK.md).

**The client asks the trainer instead** (WhatsApp, email). The trainer tells us, and we do the same by hand:

```sql
-- 1. Find the client. Note both ids.
select c.id, c.user_id from public.clients c
join public.trainers t on t.id = c.trainer_id
where t.slug = 'mario-rossi' and lower(c.email) = lower('client@example.com') and c.deleted_at is null;

-- 2. The same steps as delete_my_account.
begin;
update public.bookings set status = 'cancelled', cancelled_at = now()
 where client_id = '<client id>' and status = 'booked' and starts_at > now();
update public.clients set name = 'Deleted client', email = null, phone = null, user_id = null, deleted_at = now()
 where id = '<client id>';
commit;

-- 3. Notes are free text and are not cleared. Read them, and edit any that name the person.
select 'pack' as kind, id, note from public.pack_purchases where client_id = '<client id>' and note is not null
union all
select 'ledger', id, note from public.credit_ledger where client_id = '<client id>' and note is not null;
```

Then, if `select 1 from public.clients where user_id = '<user id>'` returns no rows, delete that login in Authentication > Users.

Write every deletion in a deletion log (date, trainer, client id). You need it after a backup restore.

## Access requests (art. 15)

The client asks the trainer, and the trainer asks us. The trainer must answer within one month (art. 12(3)). This query returns everything we hold on one client as JSON (find the client id with step 1 above):

```sql
with me as (select '<client id>'::uuid as id)
select json_build_object(
  'client',    (select row_to_json(c) from public.clients c, me where c.id = me.id),
  'login',     (select json_build_object('email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u join public.clients c on c.user_id = u.id, me where c.id = me.id),
  'bookings',  (select json_agg(b order by b.starts_at) from public.bookings b, me where b.client_id = me.id),
  'packs',     (select json_agg(p order by p.paid_at) from public.pack_purchases p, me where p.client_id = me.id),
  'ledger',    (select json_agg(l order by l.created_at) from public.credit_ledger l, me where l.client_id = me.id),
  'referrals', (select json_agg(r) from public.referrals r, me where me.id in (r.referrer_client_id, r.referred_client_id))
) as export;
```

## Backups

- Supabase Pro makes a backup every day and keeps the last 7 days. Free projects have no backups, so production is on Pro from the first paying trainer.
- Deleted and anonymized data ages out of the backups after 7 days. The privacy page says so.
- If you ever restore a backup, redo every deletion made after the backup date. That is what the deletion log is for.

## Subprocessors

List them in the DPA, and tell the trainers before adding a new one.

| Who | What for | Personal data | Where |
|---|---|---|---|
| Supabase | database, login, file storage | everything above | the project's EU region |
| Netlify | hosting and the edge function | IP addresses in request logs | US company, global network |
| Resend (Plus Five Five, Inc.) | sending the login code emails | email address | EU region (Ireland); US company, standard contractual clauses |
| Stripe (shop, pro plan) | payments through the trainer's own Payment Links | payment details, typed on Stripe's page | the trainer's own Stripe account |

Stripe is the trainer's provider, not ours: payments never pass through our app. Name it in the trainer's privacy page anyway.

## Breach procedure

A breach is any leak, loss of, or unauthorized access to personal data: a wrong row level security policy, a leaked key, a lost laptop with an export on it.

1. **Contain.** Revoke what leaked: rotate the key, remove the access, roll back the deploy.
2. **Scope.** Which trainers, which data, how many clients, since when.
3. **Tell each affected trainer in writing, without undue delay** (art. 33(2)). The trainer has 72 hours from becoming aware to notify the Garante (art. 33(1)), so every hour we take is theirs. Include what happened, which data, how many people, the likely consequences and what we did.
4. **Help** the trainer notify the Garante, and their clients when the risk to them is high (art. 34).
5. **Log it** (art. 33(5)), even when nobody had to be notified: date, facts, effects, actions.

## Fonts, cookies and banners

- **The fonts are self-hosted.** They come from the `@fontsource` packages and ship inside the build, so the app makes no requests to Google Fonts. In January 2022 a Munich court (LG München I) ruled against a site that loaded Google Fonts from Google's servers: it sent the visitor's IP address to Google without consent.
- **No analytics and no tracking cookies.** The app stores only what it technically needs in the browser (the login session, the chosen language). So **no cookie banner is needed, as long as this stays true.** Adding analytics or a third-party embed means revisiting this first.
- **App opens are counted without tracking.** Each open adds 1 to a daily counter per trainer (`app_visits`, through `log_visit`): nothing is stored in the browser, and no user, IP or device is recorded, so nobody can be followed across visits. That keeps it outside the cookie rules. Keep it that way: a visitor id, even a hashed one, would bring the banner back.
- **Images.** Real trainers' logos and covers live in our Supabase Storage. Never hotlink them from another site: that sends each client's IP address there. (The demo uses Unsplash photos. That is the demo only.)

## Referral rules and DPR 430/2001

Each trainer has a referral rules page: what each person gets, when (the new client's first paid pack), one reward per new client, and that the trainer can reverse a reward.

The reward is always the trainer's own service (a bonus session), never cash or gift cards. Italian prize law (DPR 430/2001, art. 6) excludes some promotions from the prize rules, for example an extra quantity of the same service. **A commercialista confirms before launch.** The question to ask:

> A new client gets a bonus session when they buy their first pack. The client who invited them gets a bonus session too. Is either one an "operazione a premio" under DPR 430/2001, or are both excluded under art. 6?

The referrer's reward is the uncertain one: it rewards bringing someone else, not the referrer's own purchase. If it is not excluded, there are two options: run it as a formal operazione a premio (the commercialista explains the paperwork), or switch the referrer's reward off for that trainer (`update public.trainers set bonus_referrer = 0 where slug = '...'`).
