-- Automatic alerts. The first one: "a place opened", sent by email to the clients waiting for a full session.
-- The database only decides WHO should be told and keeps them in a queue (the outbox). A small Edge Function
-- (supabase/functions/notify) writes and sends the emails through Resend and reports back. An alert problem must
-- never undo a booking or a cancellation: the trigger swallows its own errors.
--
-- Per project, once: select app_private.notify_setup('<functions url>/notify', '<sender address>');  (docs/RUNBOOK.md)

-- ── settings and the queue: private, never reachable by the API roles ───────

-- notify_url, notify_secret, notify_from (the sender address), app_base_domain (optional). Set by notify_setup().
create table app_private.settings (
  key text primary key,
  value text not null
);
alter table app_private.settings enable row level security;
revoke all on app_private.settings from public, anon, authenticated;

-- One row per message to send. It holds no address and no text: who and which session are enough, the rest is read
-- when it is sent, so an erased client or a changed name is never mailed from a stale copy.
create table app_private.outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('waitlist_open')),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  client_id uuid not null,
  session_type_id uuid not null,
  starts_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts int not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- one alert per waiting client and per cancellation, whatever happens twice
  dedupe_key text not null unique,
  foreign key (trainer_id, client_id) references public.clients (trainer_id, id) on delete cascade,
  foreign key (trainer_id, session_type_id) references public.session_types (trainer_id, id) on delete cascade
);
create index outbox_pending on app_private.outbox (created_at) where status = 'pending';
alter table app_private.outbox enable row level security;
revoke all on app_private.outbox from public, anon, authenticated;

-- ── when is an alert still worth sending? ───────────────────────────────────

-- A place is free now, and a client can still book it (outside the minimum notice).
create function app_private.slot_is_open(p_type uuid, p_starts_at timestamptz, p_now timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare t public.trainers;
begin
  select tr.* into t from public.trainers tr join public.session_types st on st.trainer_id = tr.id
   where st.id = p_type and st.active;
  if not found then return false; end if;
  if p_starts_at < p_now + make_interval(hours => t.min_notice_hours) then return false; end if;
  return exists (
    select 1 from app_private.slot_candidates(p_type, (p_starts_at at time zone t.timezone)::date, 1) c
    where c.starts_at = p_starts_at and not c.in_time_off and c.places_left > 0
  );
end $$;

-- The client is still on the list for it, still here, has an address, does not already hold the session, and the
-- place is still free. Checked when the alert is queued and again just before it goes out.
create function app_private.waitlist_alert_ok(p_client uuid, p_type uuid, p_starts_at timestamptz, p_now timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.waitlist w
    join public.clients cl on cl.id = w.client_id and cl.deleted_at is null and cl.email is not null
    where w.client_id = p_client and w.session_type_id = p_type and w.starts_at = p_starts_at
      and not exists (select 1 from public.bookings b where b.client_id = w.client_id and b.starts_at = w.starts_at and b.status = 'booked')
  ) and app_private.slot_is_open(p_type, p_starts_at, p_now)
$$;

-- ── queueing: a booking is cancelled, a place may have opened ───────────────

-- Runs inside the cancelling transaction, so a move that fails (and rolls back) queues nothing. A client is told once
-- per cancellation, and at most once an hour for the same session, so cancelling and booking in a loop cannot flood
-- the others. Their own app shows the place at once; this is the email for those who are not looking.
create function app_private.waitlist_alert_after_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if exists (
         select 1 from public.waitlist w
         where w.trainer_id = new.trainer_id and w.session_type_id = new.session_type_id and w.starts_at = new.starts_at
       )
       and app_private.slot_is_open(new.session_type_id, new.starts_at, now()) then
      insert into app_private.outbox (kind, trainer_id, client_id, session_type_id, starts_at, expires_at, dedupe_key)
      select 'waitlist_open', w.trainer_id, w.client_id, w.session_type_id, w.starts_at,
             least(w.starts_at - make_interval(hours => t.min_notice_hours), now() + interval '1 hour'),
             'waitlist_open:' || w.id || ':' || new.id
      from public.waitlist w
      join public.trainers t on t.id = w.trainer_id
      where w.trainer_id = new.trainer_id and w.session_type_id = new.session_type_id and w.starts_at = new.starts_at
        and app_private.waitlist_alert_ok(w.client_id, w.session_type_id, w.starts_at, now())
        and not exists (
          select 1 from app_private.outbox o
          where o.kind = 'waitlist_open' and o.client_id = w.client_id and o.starts_at = w.starts_at and o.created_at > now() - interval '1 hour'
        )
      order by w.created_at, w.id
      limit 20
      on conflict (dedupe_key) do nothing;
    end if;
  exception when others then
    raise warning 'waitlist alert not queued: %', sqlerrm;
  end;
  return null;
end $$;

create trigger waitlist_alert_after_cancel after update of status on public.bookings
  for each row when (old.status = 'booked' and new.status in ('cancelled', 'late_cancel'))
  execute function app_private.waitlist_alert_after_cancel();

-- ── the sender asks for work and reports back (service role only) ───────────

-- The Edge Function proves who it is with the secret in app_private.settings, which only this database and the
-- function's caller (the cron job below) know. Hands out up to p_limit alerts that are still worth sending, with
-- everything the email needs, and marks them as being tried: an alert nobody finished is offered again after
-- three minutes, five tries at most. With p_limit 0 it only checks the secret and the setup.
create function public.claim_notifications(p_secret text, p_limit int default 20)
returns table (
  id uuid, kind text, to_email text, to_name text, trainer_name text, reply_to text, locale text, timezone text,
  session_name text, starts_at timestamptz, location text, app_url text, from_address text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_base text;
begin
  if p_secret is null or p_secret is distinct from (select s.value from app_private.settings s where s.key = 'notify_secret') then
    raise exception 'NOT_ALLOWED';
  end if;
  select s.value into v_from from app_private.settings s where s.key = 'notify_from';
  if v_from is null then raise exception 'NOT_CONFIGURED'; end if;
  if coalesce(p_limit, 20) <= 0 then return; end if; -- only checking the secret and the setup: hands out nothing
  select s.value into v_base from app_private.settings s where s.key = 'app_base_domain';

  delete from app_private.outbox o where o.created_at < now() - interval '30 days';
  update app_private.outbox o set status = 'skipped', last_error = 'expired'
   where o.status = 'pending' and o.expires_at <= now();
  update app_private.outbox o set status = 'skipped', last_error = 'no longer open'
   where o.status = 'pending' and (o.claimed_at is null or o.claimed_at < now() - interval '3 minutes')
     and not app_private.waitlist_alert_ok(o.client_id, o.session_type_id, o.starts_at, now());

  return query
  with picked as (
    select o.id from app_private.outbox o
     where o.status = 'pending' and o.attempts < 5 and (o.claimed_at is null or o.claimed_at < now() - interval '3 minutes')
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 50))
       for update skip locked
  ), claimed as (
    update app_private.outbox o set attempts = o.attempts + 1, claimed_at = now()
      from picked where o.id = picked.id
    returning o.*
  )
  select c.id, c.kind, cl.email, cl.name, t.name, t.owner_email, t.locale, t.timezone, st.name, c.starts_at, loc.place,
         case when t.domain is not null then 'https://' || t.domain
              when v_base is not null then 'https://' || t.slug || '.' || v_base end,
         v_from
  from claimed c
  join public.clients cl on cl.id = c.client_id
  join public.trainers t on t.id = c.trainer_id
  join public.session_types st on st.id = c.session_type_id
  left join lateral (
    select s.location as place from app_private.slot_candidates(c.session_type_id, (c.starts_at at time zone t.timezone)::date, 1) s
     where s.starts_at = c.starts_at limit 1
  ) loc on true
  order by c.created_at;
end $$;

-- An alert went out (no error), or did not: a retry for the next call, unless it was the last try or cannot work.
create function public.finish_notification(p_secret text, p_id uuid, p_error text default null, p_retry boolean default true)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or p_secret is distinct from (select s.value from app_private.settings s where s.key = 'notify_secret') then
    raise exception 'NOT_ALLOWED';
  end if;
  update app_private.outbox o set
    status = case when p_error is null then 'sent' when p_retry and o.attempts < 5 then 'pending' else 'failed' end,
    sent_at = case when p_error is null then now() end,
    last_error = left(p_error, 300)
  where o.id = p_id and o.status = 'pending';
end $$;

-- ── waking the sender ───────────────────────────────────────────────────────

-- Called every minute by pg_cron: if something is waiting, ask the Edge Function to send it. Does nothing where
-- there is no queue to serve (tests, a project not set up yet), so it is safe to run anywhere.
create function app_private.notify_wake() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (
    select 1 from app_private.outbox o
    where o.status = 'pending' and o.attempts < 5 and o.expires_at > now()
      and (o.claimed_at is null or o.claimed_at < now() - interval '3 minutes')
  ) then
    return;
  end if;
  select s.value into v_url from app_private.settings s where s.key = 'notify_url';
  select s.value into v_secret from app_private.settings s where s.key = 'notify_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
end $$;

-- One call per project: where the function lives, which address the emails come from (on a domain verified in
-- Resend), and optionally the domain whose subdomains are the trainers' app addresses. Makes the secret once.
create function app_private.notify_setup(p_url text, p_from text, p_base_domain text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_url !~ '^https://' or p_from !~ '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$' then raise exception 'INVALID_INPUT'; end if;
  insert into app_private.settings (key, value) values ('notify_url', p_url), ('notify_from', p_from)
  on conflict (key) do update set value = excluded.value;
  if p_base_domain is not null then
    insert into app_private.settings (key, value) values ('app_base_domain', lower(p_base_domain))
    on conflict (key) do update set value = excluded.value;
  end if;
  insert into app_private.settings (key, value)
  values ('notify_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;
end $$;

-- Where the extensions exist (Supabase), install them and schedule the minute job. Elsewhere (a plain Postgres in a
-- test) there is nothing to schedule and nothing breaks.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('notify-drain', '* * * * *', 'select app_private.notify_wake()');
  end if;
end $$;

-- ── privileges: said out loud, a new function starts open to everyone ───────

revoke execute on function
  app_private.slot_is_open(uuid, timestamptz, timestamptz),
  app_private.waitlist_alert_ok(uuid, uuid, timestamptz, timestamptz),
  app_private.waitlist_alert_after_cancel(),
  app_private.notify_wake(),
  app_private.notify_setup(text, text, text)
from public, anon, authenticated;
revoke execute on function
  public.claim_notifications(text, int),
  public.finish_notification(text, uuid, text, boolean)
from public, anon, authenticated;
grant execute on function
  public.claim_notifications(text, int),
  public.finish_notification(text, uuid, text, boolean)
to service_role;
