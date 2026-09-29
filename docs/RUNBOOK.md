# Runbook

How to run the trainer apps day to day. The SQL below goes in the Supabase SQL editor. The editor runs as the `postgres` role, which skips row level security: read before you run. Replace `mario-rossi` and the ids with real ones.

## Deploy order

1. **Database first:** `npx supabase db push` (setup in the [README](../README.md), "Go live").
2. **Then the frontend:** push to the main branch. Netlify builds and publishes.

Rules:
- **Migrations are additive only: expand, then contract.** Add new columns and functions first. Remove old ones in a later migration, once no deployed code and no store app uses them.
- **Never edit a migration that already ran.** Fix forward with a new migration file.
- Run every migration on the staging project first, once it exists ([TODOS.md](../TODOS.md)).

Rollback:
- **Frontend:** Netlify > Deploys > open the last good deploy > Publish deploy. It is instant. The next push to main publishes again and replaces it: to hold the old version while you fix, use "Lock to stop auto publishing" on the Deploys page, and unlock it after the fix.
- **Database:** write a forward-fix migration. There is no "down".

## Onboard a trainer (under 1 hour)

Before you start: the trainer paid the first month and signed the terms and the DPA ([GDPR.md](GDPR.md)).

First send the trainer the form at https://puntoduestudio.it/modulo-trainer: brand, sessions, hours, contacts, contract details, logo and cover photo. No account needed. The answers are in Netlify > puntodue-studio > Forms > trainer (the page lives in the puntodue-studio repo).

1. **Look (10 min).** With the trainer, create their brand in the demo panel: name, look, colors, logo. Click **Copia SQL di attivazione**.
2. **Files (5 min).** Upload their logo and cover photo to the public Storage bucket. Put the `https://` URLs in the JSON's theme.
3. **Domain decision (5 min).** A subdomain of our app domain, or their own `app.<their-domain>`. Decide now: moving later signs every client out, and they must reinstall.
4. **Database (15 min).** Fill in the go-live SQL (slug, the trainer's login email, WhatsApp, their session types, weekly hours, products for the pro and store plans) and run it in the SQL editor. Details: [README](../README.md), "Add a trainer".
5. **Domain (10 min).** Add the Netlify domain alias, and the DNS record if needed. Wait until Netlify shows HTTPS as active.
6. **Page head (2 min).** Open `view-source:https://<their app>` in the browser. The title, theme color and manifest must be the trainer's.
7. **Owner (2 min).** The trainer opens `https://<their app>/admin` and signs in with the email in `ownerEmail`. The admin opens: the link to their login is automatic.
8. **Pages (5 min).** Their privacy page and referral rules page are online ([GDPR.md](GDPR.md)).
9. **Handover (10 min).** First install the app on the trainer's phone: the admin has **Installa l'app** at the top until it is installed (on iPhone they sign in once more in the installed app). Show the trainer the admin: book for a client, block time, "pack paid", attended or no-show, invites, the CSV export. Remind them: no health information in notes. Then they share their app link with their clients: the first screen has **Installa l'app** (Android installs in one tap; on iPhone an arrow points at Safari's Share button, or at ··· from Safari 26, then Add to Home Screen), so clients get the trainer's icon on the home screen without a store.

## Offboard a trainer

1. **Give the trainer their data.** They download the client list from the admin (CSV export: clients and sessions left). Bookings, packs and the ledger are not in it: run these and download each result as CSV from the SQL editor.
   ```sql
   select c.name as client, s.name as session, b.starts_at at time zone t.timezone as starts_local, b.status, b.booked_by, b.location
   from public.bookings b
   join public.clients c on c.id = b.client_id
   join public.session_types s on s.id = b.session_type_id
   join public.trainers t on t.id = b.trainer_id
   where t.slug = 'mario-rossi'
   order by b.starts_at;

   select c.name as client, p.credits, p.price_cents / 100.0 as price_eur, p.method,
          p.paid_at at time zone t.timezone as paid_local, p.voided_at, p.note
   from public.pack_purchases p
   join public.clients c on c.id = p.client_id
   join public.trainers t on t.id = p.trainer_id
   where t.slug = 'mario-rossi'
   order by p.paid_at;

   select c.name as client, l.created_at at time zone t.timezone as at_local, l.delta, l.reason, l.note
   from public.credit_ledger l
   join public.clients c on c.id = l.client_id
   join public.trainers t on t.id = l.trainer_id
   where t.slug = 'mario-rossi'
   order by l.created_at;
   ```
2. **List the logins to remove, before deleting anything.** One login can serve several trainer apps. This lists the logins of this trainer and their clients that no other trainer uses. Save the result.
   ```sql
   with gone as (
     select c.user_id as id from public.clients c
     join public.trainers t on t.id = c.trainer_id
     where t.slug = 'mario-rossi' and c.user_id is not null
     union
     select owner_user_id from public.trainers where slug = 'mario-rossi' and owner_user_id is not null
   )
   select g.id from gone g
   where not exists (select 1 from public.clients o join public.trainers t on t.id = o.trainer_id
                     where o.user_id = g.id and t.slug <> 'mario-rossi')
     and not exists (select 1 from public.trainers t where t.owner_user_id = g.id and t.slug <> 'mario-rossi');
   ```
3. **Delete the data as the DPA says**, on the date it sets, after step 1's exports are saved. Packs and the credit ledger are accounting records, so the database refuses to delete a trainer who still has them: remove them on purpose first. The last statement removes the trainer and everything else that belongs to them: clients, bookings, referrals, session types, availability, products.
   ```sql
   begin;
   delete from public.credit_ledger where trainer_id = (select id from public.trainers where slug = 'mario-rossi');
   delete from public.pack_purchases where trainer_id = (select id from public.trainers where slug = 'mario-rossi');
   delete from public.trainers where slug = 'mario-rossi';
   commit;
   ```
   Then delete the saved logins (Authentication > Users) and the trainer's files in Storage. The deleted rows leave the daily backups within 7 days.
4. **Remove the Netlify domain alias.** Never leave it: a dead alias can block the certificate renewal for every trainer (see "Netlify facts"). For their own domain, ask the trainer to delete the CNAME too.
5. **Store plan:** the trainer removes the apps from sale in App Store Connect and Play Console, and removes Punto Due's access. Delete our copy of their API key.
6. Stop the subscription invoice.

## Incidents

### The app does not load

1. **One trainer or all?** Open two trainer apps.
   - Only one fails: check that trainer's domain in Netlify (Domain management: DNS and HTTPS status) and their `slug` and `domain` in `public.trainers`. A host that matches no trainer shows "This app doesn't exist" (`TENANT_NOT_FOUND`).
   - All fail: go on.
2. **Netlify > Deploys.** Did the last deploy fail, or publish something broken? Roll back (see "Deploy order").
3. **Supabase.** Check status.supabase.com and the project dashboard: is the project paused, or over a limit?
4. **Look closer.** Open the browser console on the app: errors carry a named code (`NETWORK`, `TENANT_NOT_FOUND`, and so on). Netlify > Logs > Edge Functions shows `tenant-head` errors. By design, when that function fails it serves the plain page with a generic title, so it cannot blank the app by itself.

### Clients do not receive the login code

1. **Spam.** Ask them to check spam and the Promotions tab, and to search for the sender address.
2. **Newest code only.** A new code replaces the old one. Codes expire after 1 hour, and a client can ask for a new one once a minute.
3. **Resend.** Open Emails in Resend: was it sent, delivered, bounced or blocked? The free plan sends 100 emails a day.
4. **Supabase.** Authentication > Rate Limits: we set 100 emails an hour (the default with custom SMTP is lower). Logs > Auth shows SMTP errors.
5. **Templates.** Both **Magic link or OTP** and **Confirm sign up** must show `{{ .Token }}`, and Sign In / Providers > Email > **Email OTP length** must be 6 (new projects start at 8). A new client who gets a link instead of a code means Confirm sign up was missed.

### The trainer signs in but does not see the admin

The admin belongs to the login whose confirmed email matches the trainer's `owner_email`.

1. **Right address?** Check that they signed in with exactly that email:
   ```sql
   select slug, owner_email, owner_user_id from public.trainers where slug = 'mario-rossi';
   ```
2. **Wrong address in the trainer row:** fix `ownerEmail` in their go-live JSON and run it again. A login that already exists is linked at once.
3. **Still empty `owner_user_id`:** the login exists but its email was never confirmed (they never typed a code). Ask them to sign in again with the code. As a last resort, link it by hand:
   ```sql
   update public.trainers
      set owner_user_id = (select id from auth.users where lower(email) = 'mario@example.com')
    where slug = 'mario-rossi';
   ```

### A client says their balance is wrong

The balance is the sum of the client's ledger rows. There is no counter to fix, only rows to read. This lists every movement with a running total:

```sql
select l.created_at at time zone t.timezone as at_local, l.delta, l.reason, l.note,
       sum(l.delta) over (order by l.created_at, l.id) as balance_after,
       b.starts_at at time zone t.timezone as session_local, b.status as session_status,
       p.credits as pack_credits, p.voided_at as pack_voided_at
from public.credit_ledger l
join public.clients c on c.id = l.client_id
join public.trainers t on t.id = c.trainer_id
left join public.bookings b on b.id = l.booking_id
left join public.pack_purchases p on p.id = l.pack_id
where t.slug = 'mario-rossi' and lower(c.email) = lower('client@example.com')
order by l.created_at, l.id;
```

The reasons: `pack` (+), `pack_void` (-), `booking` (-), `refund` (+), `referral` (+), `referral_reversal` (-), `manual` (+ or -). A late cancel has no `refund` row: that is the cancellation policy working, not a bug.

The fixes:
- **A pack entered twice:** void one with `void_pack`. It adds a `pack_void` row. The admin has no button for this yet, so use SQL.
- **Anything else agreed with the trainer:** a manual row with `adjust_credits`. The trainer can do this in the admin, on the client.

Both functions only work for the trainer, so in SQL act as the trainer first, inside one transaction:

```sql
begin;
select set_config('request.jwt.claim.sub',
  (select owner_user_id::text from public.trainers where slug = 'mario-rossi'), true);
select public.void_pack('<pack id>');
select public.adjust_credits('<client id>', 1, 'Punto Due: correction agreed with the trainer', gen_random_uuid());
commit;
```

The history records the trainer as the author, so start the note with "Punto Due:".

### delete_my_account warned that the auth user was kept

When a client deletes their account, `delete_my_account` anonymizes their client row and tries to delete their login. If the database is not allowed to delete from `auth.users`, it keeps the login and writes a warning to the Postgres log: `auth user <id> kept: delete it with the Auth admin API`.

1. **Find it:** Supabase > Logs > Postgres, search for `kept`.
2. **Check that the login is unused.** This must return no rows:
   ```sql
   select trainer_id from public.clients where user_id = '<id>';
   ```
3. **Delete it:** Authentication > Users, search for the id, Delete user. Or use the Auth admin API from your own terminal (`curl.exe` in PowerShell):
   ```
   curl.exe -X DELETE "https://<ref>.supabase.co/auth/v1/admin/users/<id>" -H "apikey: <service_role key>" -H "Authorization: Bearer <service_role key>"
   ```
   The service_role key never goes into the repo, Netlify or the frontend.

### Double booking suspected

The database makes a real double booking hard:
- Every booking, by a client or by the trainer, first locks the trainer's row. Bookings for one trainer run one at a time, so the second of two racing requests sees the first.
- A unique index stops the same client being booked twice at the same start.

So first check that both sessions are in the app at all. Usually one was agreed on WhatsApp and never entered: the trainer books it for the client in the admin, or blocks the time.

Overlapping sessions that are not the same group slot:

```sql
select a.starts_at at time zone t.timezone as starts_local, a.id, a.status, b.id as other_id, b.status as other_status
from public.bookings a
join public.bookings b on b.trainer_id = a.trainer_id and a.id < b.id
  and b.starts_at < a.ends_at and b.ends_at > a.starts_at
join public.trainers t on t.id = a.trainer_id
where t.slug = 'mario-rossi'
  and a.status in ('booked', 'attended', 'no_show') and b.status in ('booked', 'attended', 'no_show')
  and not (a.session_type_id = b.session_type_id and a.starts_at = b.starts_at)
order by a.starts_at;
```

Group slots over capacity:

```sql
select b.starts_at at time zone t.timezone as starts_local, s.name, count(*) as booked, s.capacity
from public.bookings b
join public.session_types s on s.id = b.session_type_id
join public.trainers t on t.id = b.trainer_id
where t.slug = 'mario-rossi' and b.status in ('booked', 'attended', 'no_show')
group by b.starts_at, t.timezone, s.id
having count(*) > s.capacity
order by 1;
```

If a real overlap exists, the trainer cancels one booking (a trainer's cancel always refunds) and rebooks it. If the app itself let it happen, it is a bug: save both booking rows and add a case to `tests/scenarios.ts` that reproduces it.

## Netlify facts

- A site can have **100 domain aliases**. Every trainer on a subdomain or on their own domain uses one.
- **All aliases share one certificate.** If one alias stops pointing to Netlify (the trainer changed DNS provider, a domain expired), the certificate renewal can fail for the whole site, and every trainer's app gets a certificate error.
  - Check the DNS of all aliases once a month: Netlify > Domain management flags broken ones, or run `nslookup <alias>` and check that it still points to the Netlify site.
  - Remove the alias at every offboarding.
- **Fallback:** a second Netlify site from the same repo, with the same environment variables. New trainers go there when 100 is not enough, or to isolate an alias that keeps failing.
- **Choose a trainer's final domain before clients install.** The login and the home-screen install belong to the domain. Moving a trainer to another domain signs every client out, and they must remove and reinstall the home-screen app.
