-- Trainer apps: one database, many trainers. Every row carries trainer_id.
-- Clients read their own rows through row level security; everything that moves
-- credits goes through the SECURITY DEFINER functions below, never direct writes.
-- The same rules exist in src/demo.ts; tests/scenarios.ts runs against both.

create schema if not exists app_private;
alter default privileges in schema app_private revoke execute on functions from public;

-- ── tables ──────────────────────────────────────────────────────────────────

create table public.trainers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  -- a domain always has a dot and a slug never does: one key can never match two trainers
  domain text unique check (domain is null or (char_length(domain) <= 253 and domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$')),
  owner_user_id uuid references auth.users (id) on delete set null,
  -- the trainer's login email: whoever signs in with it becomes the owner (see link_owner below)
  owner_email text check (owner_email is null or (owner_email = lower(owner_email) and owner_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  name text not null check (char_length(name) between 1 and 80),
  tagline text not null default '' check (char_length(tagline) <= 140),
  plan text not null default 'web' check (plan in ('web', 'pro', 'store')),
  template text not null default 'studio' check (template in ('studio', 'energy', 'luxe')),
  theme jsonb not null default '{"brand": "#1F4BFF"}'::jsonb check (
    theme ->> 'brand' ~ '^#[0-9a-fA-F]{6}$'
    and (theme ->> 'accent' is null or theme ->> 'accent' ~ '^#[0-9a-fA-F]{6}$')
    and (theme ->> 'mode' is null or theme ->> 'mode' in ('light', 'dark', 'auto'))
    and (theme ->> 'logo' is null or theme ->> 'logo' ~ '^https://')
    and (theme ->> 'cover' is null or theme ->> 'cover' ~ '^https://')
  ),
  whatsapp text check (whatsapp is null or whatsapp ~ '^\+?[0-9]{6,15}$'),
  instagram text check (instagram is null or instagram ~ '^https://'),
  -- an unknown zone fails here, when it is saved, not later on the trainer's booking page
  timezone text not null default 'Europe/Rome' check ((timestamp '2000-01-01 12:00' at time zone timezone) is not null),
  locale text not null default 'it' check (locale in ('it', 'en')),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  slot_step_minutes int not null default 30 check (slot_step_minutes in (15, 20, 30, 60)),
  min_notice_hours int not null default 2 check (min_notice_hours between 0 and 72),
  booking_horizon_days int not null default 28 check (booking_horizon_days between 1 and 90),
  cancel_window_hours int not null default 24 check (cancel_window_hours between 0 and 168),
  bonus_referrer int not null default 1 check (bonus_referrer between 0 and 10),
  bonus_referred int not null default 1 check (bonus_referred between 0 and 10),
  terms_version int not null default 1,
  created_at timestamptz not null default now()
);
create index trainers_owner on public.trainers (owner_user_id) where owner_user_id is not null;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null, -- null: added by the trainer, no login yet
  name text not null check (char_length(name) between 1 and 80),
  email text check (email is null or (char_length(email) <= 254 and email like '%_@_%')),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{6,20}$'),
  referral_code text not null check (referral_code ~ '^[A-Z0-9]{4,12}$'),
  terms_accepted_at timestamptz,
  terms_version int,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (trainer_id, id),
  unique (trainer_id, user_id),
  unique (trainer_id, referral_code)
);
create unique index clients_email_per_trainer on public.clients (trainer_id, lower(email)) where email is not null and deleted_at is null;
create index clients_user on public.clients (user_id);

create table public.session_types (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text check (char_length(description) <= 200),
  minutes int not null check (minutes between 15 and 240),
  capacity int not null default 1 check (capacity between 1 and 30),
  credits int not null default 1 check (credits between 0 and 10),
  active boolean not null default true,
  sort int not null default 0,
  unique (trainer_id, id)
);

create table public.availability (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  weekday int not null check (weekday between 1 and 7), -- ISO: 1 = Monday
  start_time time not null,
  end_time time not null,
  location text check (char_length(location) <= 80),
  session_type_id uuid, -- set: this window only offers that session type
  check (end_time > start_time),
  foreign key (trainer_id, session_type_id) references public.session_types (trainer_id, id) on delete cascade
);
create index availability_trainer on public.availability (trainer_id);

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text check (char_length(note) <= 140),
  check (ends_at > starts_at)
);
create index time_off_trainer on public.time_off (trainer_id, starts_at);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  client_id uuid not null,
  session_type_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  status text not null default 'booked' check (status in ('booked', 'cancelled', 'late_cancel', 'attended', 'no_show')),
  booked_by text not null default 'client' check (booked_by in ('client', 'trainer')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  check (ends_at > starts_at),
  unique (trainer_id, id),
  foreign key (trainer_id, client_id) references public.clients (trainer_id, id) on delete cascade,
  foreign key (trainer_id, session_type_id) references public.session_types (trainer_id, id)
);
create index bookings_trainer_start on public.bookings (trainer_id, starts_at);
create index bookings_client_start on public.bookings (client_id, starts_at);
-- the sessions that hold a place: overlap checks and group capacity read only these
create index bookings_trainer_active on public.bookings (trainer_id, starts_at) include (ends_at, session_type_id)
  where status in ('booked', 'attended', 'no_show');
create index bookings_type_start on public.bookings (session_type_id, starts_at) where status in ('booked', 'attended', 'no_show');
-- A retried request can never book the same client twice at the same time.
create unique index bookings_one_active_per_client_start on public.bookings (client_id, starts_at) where status = 'booked';

-- Packs and the ledger are accounting records: deleting a trainer or a client never takes
-- them along silently (on delete restrict). Offboarding deletes them on purpose (RUNBOOK).
create table public.pack_purchases (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete restrict,
  client_id uuid not null,
  credits int not null check (credits between 1 and 200),
  price_cents int check (price_cents between 0 and 1000000),
  method text not null check (method in ('cash', 'transfer', 'pos', 'satispay', 'other')),
  paid_at timestamptz not null default now(),
  note text check (char_length(note) <= 140),
  op_id uuid not null unique, -- generated by the app per tap: a retry cannot add credits twice
  created_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  unique (trainer_id, id),
  foreign key (trainer_id, client_id) references public.clients (trainer_id, id) on delete restrict
);
create index pack_purchases_client on public.pack_purchases (trainer_id, client_id);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  referrer_client_id uuid not null,
  referred_client_id uuid not null unique, -- one referrer per client, ever
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'reversed')),
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  reversed_at timestamptz,
  check (referrer_client_id <> referred_client_id),
  foreign key (trainer_id, referrer_client_id) references public.clients (trainer_id, id) on delete cascade,
  foreign key (trainer_id, referred_client_id) references public.clients (trainer_id, id) on delete cascade
);
create index referrals_trainer on public.referrals (trainer_id);
create index referrals_referrer on public.referrals (referrer_client_id);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete restrict,
  client_id uuid not null,
  delta int not null check (delta <> 0 and delta between -200 and 200),
  reason text not null check (reason in ('pack', 'pack_void', 'booking', 'refund', 'referral', 'referral_reversal', 'manual')),
  booking_id uuid references public.bookings (id) on delete set null,
  pack_id uuid references public.pack_purchases (id) on delete set null,
  referral_id uuid references public.referrals (id) on delete set null,
  note text check (char_length(note) <= 140),
  op_id uuid unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (trainer_id, client_id) references public.clients (trainer_id, id) on delete restrict
);
create index credit_ledger_client on public.credit_ledger (client_id);
create index credit_ledger_trainer on public.credit_ledger (trainer_id, created_at);
create index credit_ledger_booking on public.credit_ledger (booking_id) where booking_id is not null;
create index credit_ledger_referral on public.credit_ledger (referral_id) where referral_id is not null;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 280),
  price_cents int not null check (price_cents between 0 and 1000000),
  image_url text check (image_url is null or image_url ~ '^https://'),
  payment_url text not null check (payment_url ~ '^https://'),
  active boolean not null default true,
  sort int not null default 0
);
create index products_trainer on public.products (trainer_id);

-- ── helpers (used by policies, so readable by the API roles) ────────────────

create function app_private.is_owner(p_trainer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trainers t where t.id = p_trainer and t.owner_user_id = auth.uid())
$$;

create function app_private.my_client_id(p_trainer uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.clients c where c.trainer_id = p_trainer and c.user_id = auth.uid() and c.deleted_at is null
$$;

create function app_private.balance(p_client uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.delta), 0)::int from public.credit_ledger l where l.client_id = p_client
$$;

create function app_private.new_referral_code(p_trainer uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare v text;
begin
  loop
    v := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.clients c where c.trainer_id = p_trainer and c.referral_code = v);
  end loop;
  return v;
end $$;

-- ── slots: generated in the trainer's time zone, daylight saving included ───

create function app_private.slot_candidates(p_type uuid, p_from date, p_days int)
returns table (starts_at timestamptz, ends_at timestamptz, places_left int, in_time_off boolean, location text)
language sql stable security definer set search_path = '' as $$
  with st as (select * from public.session_types where id = p_type),
  tr as (select t.* from public.trainers t join st on st.trainer_id = t.id),
  days as (select (p_from + g)::date as day from generate_series(0, p_days - 1) as g),
  starts as (
    select distinct on (local_start) local_start, a.location
    from days d
    join public.availability a
      on a.trainer_id = (select id from tr)
     and a.weekday = extract(isodow from d.day)::int
     and (a.session_type_id is null or a.session_type_id = p_type)
    cross join lateral generate_series(
      d.day + a.start_time,
      d.day + a.end_time - make_interval(mins => (select minutes from st)),
      make_interval(mins => (select slot_step_minutes from tr))
    ) as local_start
    order by local_start, a.location
  ),
  cand as (
    select s.local_start at time zone (select timezone from tr) as start_utc, s.local_start, s.location
    from starts s
  )
  select
    c.start_utc,
    c.start_utc + make_interval(mins => (select minutes from st)),
    case
      when exists (
        select 1 from public.bookings b
        where b.trainer_id = (select id from tr)
          and b.status in ('booked', 'attended', 'no_show')
          and b.starts_at < c.start_utc + make_interval(mins => (select minutes from st))
          and b.ends_at > c.start_utc
          and not (b.session_type_id = p_type and b.starts_at = c.start_utc)
      ) then 0
      else greatest(0, (select capacity from st) - (
        select count(*)::int from public.bookings b
        where b.session_type_id = p_type and b.starts_at = c.start_utc and b.status in ('booked', 'attended', 'no_show')
      ))
    end,
    exists (
      select 1 from public.time_off o
      where o.trainer_id = (select id from tr)
        and o.starts_at < c.start_utc + make_interval(mins => (select minutes from st))
        and o.ends_at > c.start_utc
    ),
    c.location
  from cand c
  -- a wall time that does not exist on spring-forward day does not round-trip: skip it
  where (c.start_utc at time zone (select timezone from tr)) = c.local_start
  order by 1
$$;

create function app_private.free_slots(p_type uuid, p_from date, p_days int, p_now timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz, places_left int, location text)
language plpgsql stable security definer set search_path = '' as $$
declare t public.trainers;
begin
  select tr.* into t from public.trainers tr join public.session_types st on st.trainer_id = tr.id
   where st.id = p_type and st.active;
  if not found then raise exception 'NOT_FOUND'; end if;
  if app_private.my_client_id(t.id) is null and not app_private.is_owner(t.id) then raise exception 'NOT_ALLOWED'; end if;
  if p_days is null or p_days < 1 or p_days > 31 then raise exception 'INVALID_INPUT'; end if;
  return query
    select c.starts_at, c.ends_at, c.places_left, c.location
    from app_private.slot_candidates(p_type, p_from, p_days) c
    where not c.in_time_off
      and c.places_left > 0
      and c.starts_at >= p_now + make_interval(hours => t.min_notice_hours)
      and c.starts_at <= p_now + make_interval(days => t.booking_horizon_days);
end $$;

-- ── booking ─────────────────────────────────────────────────────────────────

create function app_private.book(p_type uuid, p_starts_at timestamptz, p_now timestamptz)
returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare
  st public.session_types;
  t public.trainers;
  v_client uuid;
  b public.bookings;
  c record;
begin
  select * into st from public.session_types where id = p_type and active;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- one booking at a time per trainer: the second of two racing requests sees the first
  select * into t from public.trainers where id = st.trainer_id for update;
  v_client := app_private.my_client_id(t.id);
  if v_client is null then raise exception 'NOT_ALLOWED'; end if;

  select * into b from public.bookings where client_id = v_client and starts_at = p_starts_at and status = 'booked';
  if found then return b; end if; -- a retry of the same request

  if p_starts_at < p_now + make_interval(hours => t.min_notice_hours) then raise exception 'TOO_SOON'; end if;
  if p_starts_at > p_now + make_interval(days => t.booking_horizon_days) then raise exception 'TOO_FAR'; end if;
  select * into c from app_private.slot_candidates(p_type, (p_starts_at at time zone t.timezone)::date, 1) s
   where s.starts_at = p_starts_at;
  if not found or c.in_time_off then raise exception 'OUTSIDE_HOURS'; end if;
  if c.places_left <= 0 then raise exception 'SLOT_TAKEN'; end if;
  if app_private.balance(v_client) < st.credits then raise exception 'NO_CREDITS'; end if;

  insert into public.bookings (trainer_id, client_id, session_type_id, starts_at, ends_at, location, booked_by)
  values (t.id, v_client, st.id, p_starts_at, p_starts_at + make_interval(mins => st.minutes), c.location, 'client')
  returning * into b;
  if st.credits > 0 then
    insert into public.credit_ledger (trainer_id, client_id, delta, reason, booking_id, created_by)
    values (t.id, v_client, -st.credits, 'booking', b.id, auth.uid());
  end if;
  return b;
end $$;

-- The trainer books for a client (WhatsApp, phone, in person): any hour, never over
-- another session, and the balance may go negative until the next pack.
create function public.trainer_book(p_client uuid, p_type uuid, p_starts_at timestamptz)
returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare
  cl public.clients;
  t public.trainers;
  st public.session_types;
  b public.bookings;
  v_conflict boolean;
  v_taken int;
begin
  select * into cl from public.clients where id = p_client and deleted_at is null;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into t from public.trainers where id = cl.trainer_id for update;
  if not app_private.is_owner(t.id) then raise exception 'NOT_ALLOWED'; end if;
  select * into st from public.session_types where id = p_type and trainer_id = t.id and active;
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into b from public.bookings where client_id = cl.id and starts_at = p_starts_at and status = 'booked';
  if found then return b; end if;

  select exists (
    select 1 from public.bookings x
    where x.trainer_id = t.id and x.status in ('booked', 'attended', 'no_show')
      and x.starts_at < p_starts_at + make_interval(mins => st.minutes) and x.ends_at > p_starts_at
      and not (x.session_type_id = st.id and x.starts_at = p_starts_at)
  ) into v_conflict;
  select count(*) into v_taken from public.bookings x
   where x.session_type_id = st.id and x.starts_at = p_starts_at and x.status in ('booked', 'attended', 'no_show');
  if v_conflict or v_taken >= st.capacity then raise exception 'SLOT_TAKEN'; end if;

  insert into public.bookings (trainer_id, client_id, session_type_id, starts_at, ends_at, booked_by)
  values (t.id, cl.id, st.id, p_starts_at, p_starts_at + make_interval(mins => st.minutes), 'trainer')
  returning * into b;
  if st.credits > 0 then
    insert into public.credit_ledger (trainer_id, client_id, delta, reason, booking_id, created_by)
    values (t.id, cl.id, -st.credits, 'booking', b.id, auth.uid());
  end if;
  return b;
end $$;

create function app_private.cancel(p_booking uuid, p_now timestamptz)
returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  t public.trainers;
  v_owner boolean;
  v_refund int;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into t from public.trainers where id = b.trainer_id;
  v_owner := app_private.is_owner(t.id);
  if not v_owner and b.client_id is distinct from app_private.my_client_id(t.id) then raise exception 'NOT_ALLOWED'; end if;
  if b.status <> 'booked' then raise exception 'NOT_FOUND'; end if;
  if not v_owner and p_now >= b.starts_at then raise exception 'NOT_ALLOWED'; end if;

  if v_owner or b.starts_at - p_now >= make_interval(hours => t.cancel_window_hours) then
    update public.bookings set status = 'cancelled', cancelled_at = p_now, cancelled_by = auth.uid() where id = b.id returning * into b;
    select -coalesce(sum(l.delta), 0) into v_refund from public.credit_ledger l where l.booking_id = b.id and l.reason = 'booking';
    if v_refund > 0 then
      insert into public.credit_ledger (trainer_id, client_id, delta, reason, booking_id, created_by)
      values (t.id, b.client_id, v_refund, 'refund', b.id, auth.uid());
    end if;
  else
    -- inside the cancellation window the session is still charged
    update public.bookings set status = 'late_cancel', cancelled_at = p_now, cancelled_by = auth.uid() where id = b.id returning * into b;
  end if;
  return b;
end $$;

create function app_private.set_attendance(p_booking uuid, p_status text, p_now timestamptz)
returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not app_private.is_owner(b.trainer_id) then raise exception 'NOT_ALLOWED'; end if;
  if p_status not in ('attended', 'no_show') then raise exception 'INVALID_INPUT'; end if;
  if b.status not in ('booked', 'attended', 'no_show') then raise exception 'NOT_FOUND'; end if;
  if b.starts_at > p_now then raise exception 'NOT_ALLOWED'; end if;
  update public.bookings set status = p_status where id = b.id returning * into b;
  return b;
end $$;

-- ── packs, credits and the two-sided referral ───────────────────────────────

create function public.mark_pack_paid(p_client uuid, p_credits int, p_price_cents int, p_method text, p_note text, p_op_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  cl public.clients;
  t public.trainers;
  p public.pack_purchases;
  r public.referrals;
  v_rewarded boolean := false;
begin
  select * into cl from public.clients where id = p_client and deleted_at is null;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into t from public.trainers where id = cl.trainer_id for update;
  if not app_private.is_owner(t.id) then raise exception 'NOT_ALLOWED'; end if;
  if p_credits is null or p_credits < 1 or p_credits > 200 or p_op_id is null
     or p_method is null or p_method not in ('cash', 'transfer', 'pos', 'satispay', 'other')
     or (p_price_cents is not null and (p_price_cents < 0 or p_price_cents > 1000000)) then
    raise exception 'INVALID_INPUT';
  end if;
  select * into p from public.pack_purchases where op_id = p_op_id;
  if found then return json_build_object('pack_id', p.id, 'rewarded', false); end if;

  insert into public.pack_purchases (trainer_id, client_id, credits, price_cents, method, note, op_id, created_by)
  values (t.id, cl.id, p_credits, p_price_cents, p_method, nullif(trim(p_note), ''), p_op_id, auth.uid())
  returning * into p;
  insert into public.credit_ledger (trainer_id, client_id, delta, reason, pack_id, created_by)
  values (t.id, cl.id, p_credits, 'pack', p.id, auth.uid());

  -- both people are rewarded once, when the new client's first pack is paid
  select * into r from public.referrals where referred_client_id = cl.id and status = 'pending' for update;
  if found then
    if t.bonus_referred > 0 then
      insert into public.credit_ledger (trainer_id, client_id, delta, reason, referral_id, created_by)
      values (t.id, cl.id, t.bonus_referred, 'referral', r.id, auth.uid());
    end if;
    if t.bonus_referrer > 0 then
      insert into public.credit_ledger (trainer_id, client_id, delta, reason, referral_id, created_by)
      values (t.id, r.referrer_client_id, t.bonus_referrer, 'referral', r.id, auth.uid());
    end if;
    update public.referrals set status = 'rewarded', rewarded_at = now() where id = r.id;
    v_rewarded := true;
  end if;
  return json_build_object('pack_id', p.id, 'rewarded', v_rewarded);
end $$;

create function public.void_pack(p_pack uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.pack_purchases;
begin
  select * into p from public.pack_purchases where id = p_pack and voided_at is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not app_private.is_owner(p.trainer_id) then raise exception 'NOT_ALLOWED'; end if;
  update public.pack_purchases set voided_at = now(), voided_by = auth.uid() where id = p.id;
  insert into public.credit_ledger (trainer_id, client_id, delta, reason, pack_id, created_by)
  values (p.trainer_id, p.client_id, -p.credits, 'pack_void', p.id, auth.uid());
end $$;

create function public.adjust_credits(p_client uuid, p_delta int, p_note text, p_op_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cl public.clients;
begin
  select * into cl from public.clients where id = p_client and deleted_at is null;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not app_private.is_owner(cl.trainer_id) then raise exception 'NOT_ALLOWED'; end if;
  if p_delta is null or p_delta = 0 or p_delta < -200 or p_delta > 200 or p_op_id is null then raise exception 'INVALID_INPUT'; end if;
  -- a retry, even one racing the first request, adds nothing
  insert into public.credit_ledger (trainer_id, client_id, delta, reason, note, op_id, created_by)
  values (cl.trainer_id, cl.id, p_delta, 'manual', left(nullif(trim(p_note), ''), 140), p_op_id, auth.uid())
  on conflict (op_id) do nothing;
end $$;

create function public.reverse_referral(p_referral uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  select * into r from public.referrals where id = p_referral and status <> 'reversed' for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not app_private.is_owner(r.trainer_id) then raise exception 'NOT_ALLOWED'; end if;
  if r.status = 'rewarded' then
    insert into public.credit_ledger (trainer_id, client_id, delta, reason, referral_id, created_by)
    select l.trainer_id, l.client_id, -l.delta, 'referral_reversal', r.id, auth.uid()
    from public.credit_ledger l where l.referral_id = r.id and l.reason = 'referral';
  end if;
  update public.referrals set status = 'reversed', reversed_at = now() where id = r.id;
end $$;

-- ── clients ─────────────────────────────────────────────────────────────────

create function public.join_trainer(p_trainer uuid, p_name text, p_phone text default null, p_referral_code text default null, p_accept_terms boolean default false)
returns public.clients
language plpgsql security definer set search_path = '' as $$
declare
  t public.trainers;
  c public.clients;
  v_email text;
  v_referrer public.clients;
begin
  if auth.uid() is null then raise exception 'NOT_ALLOWED'; end if;
  -- the lock makes a double-submitted join return the first one's client, not an error
  select * into t from public.trainers where id = p_trainer for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into c from public.clients where trainer_id = t.id and user_id = auth.uid() and deleted_at is null;
  if found then return c; end if;
  if not coalesce(p_accept_terms, false) then raise exception 'INVALID_INPUT'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 80 then raise exception 'INVALID_INPUT'; end if;
  if nullif(trim(p_phone), '') is not null and trim(p_phone) !~ '^\+?[0-9 ]{6,20}$' then raise exception 'INVALID_INPUT'; end if;
  select u.email into v_email from auth.users u where u.id = auth.uid();

  -- a client the trainer already added with this email becomes this login
  update public.clients
     set user_id = auth.uid(), terms_accepted_at = now(), terms_version = t.terms_version
   where trainer_id = t.id and user_id is null and deleted_at is null and v_email is not null and lower(email) = lower(v_email)
  returning * into c;
  if found then return c; end if;

  insert into public.clients (trainer_id, user_id, name, email, phone, referral_code, terms_accepted_at, terms_version)
  values (t.id, auth.uid(), trim(p_name), v_email, nullif(trim(p_phone), ''), app_private.new_referral_code(t.id), now(), t.terms_version)
  returning * into c;

  if p_referral_code is not null then
    select * into v_referrer from public.clients
     where trainer_id = t.id and referral_code = upper(trim(p_referral_code)) and deleted_at is null and id <> c.id;
    if found and v_referrer.user_id is distinct from auth.uid() then
      insert into public.referrals (trainer_id, referrer_client_id, referred_client_id) values (t.id, v_referrer.id, c.id);
    end if;
  end if;
  return c;
end $$;

create function public.trainer_add_client(p_trainer uuid, p_name text, p_email text default null, p_phone text default null)
returns public.clients
language plpgsql security definer set search_path = '' as $$
declare c public.clients;
begin
  if not app_private.is_owner(p_trainer) then raise exception 'NOT_ALLOWED'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 80 then raise exception 'INVALID_INPUT'; end if;
  if nullif(trim(p_email), '') is not null and trim(p_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'INVALID_INPUT'; end if;
  if nullif(trim(p_phone), '') is not null and trim(p_phone) !~ '^\+?[0-9 ]{6,20}$' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.clients x where x.trainer_id = p_trainer and x.deleted_at is null and lower(x.email) = lower(trim(p_email))) then
    raise exception 'INVALID_INPUT';
  end if;
  insert into public.clients (trainer_id, name, email, phone, referral_code)
  values (p_trainer, trim(p_name), nullif(trim(p_email), ''), nullif(trim(p_phone), ''), app_private.new_referral_code(p_trainer))
  returning * into c;
  return c;
end $$;

create function public.my_referrals(p_trainer uuid)
returns table (id uuid, name text, status text, created_at timestamptz, rewarded_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, split_part(c.name, ' ', 1), r.status, r.created_at, r.rewarded_at
  from public.referrals r join public.clients c on c.id = r.referred_client_id
  where r.trainer_id = p_trainer and r.referrer_client_id = app_private.my_client_id(p_trainer)
  order by r.created_at desc
$$;

-- GDPR erasure: anonymize this trainer's client record, keep the ledger for accounting.
create function public.delete_my_account(p_trainer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
  v_user uuid := auth.uid();
begin
  v_client := app_private.my_client_id(p_trainer);
  if v_client is null then raise exception 'NOT_FOUND'; end if;
  update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = v_user
   where client_id = v_client and status = 'booked' and starts_at > now();
  update public.clients set name = 'Deleted client', email = null, phone = null, user_id = null, deleted_at = now()
   where id = v_client;
  -- one login serves every trainer app on this platform: remove it only when unused,
  -- and never a trainer's own login (their admin would lose its owner)
  if not exists (select 1 from public.clients where user_id = v_user)
     and not exists (select 1 from public.trainers where owner_user_id = v_user) then
    begin
      delete from auth.users where id = v_user;
    exception when insufficient_privilege then
      raise warning 'auth user % kept: delete it with the Auth admin API (see docs/RUNBOOK.md)', v_user;
    end;
  end if;
end $$;

create function public.trainer_public(p_key text)
returns table (
  id uuid, slug text, name text, tagline text, template text, theme jsonb, plan text, whatsapp text, instagram text,
  timezone text, locale text, currency text, slot_step_minutes int, min_notice_hours int, booking_horizon_days int,
  cancel_window_hours int, bonus_referrer int, bonus_referred int, terms_version int
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.slug, t.name, t.tagline, t.template, t.theme, t.plan, t.whatsapp, t.instagram,
         t.timezone, t.locale, t.currency, t.slot_step_minutes, t.min_notice_hours, t.booking_horizon_days,
         t.cancel_window_hours, t.bonus_referrer, t.bonus_referred, t.terms_version
  from public.trainers t
  where t.slug = lower(trim(p_key)) or t.domain = lower(trim(p_key))
  limit 1
$$;

-- ── onboarding: run by the operator in the Supabase SQL editor ──────────────

-- The trainer's login becomes the owner of their app once its email is confirmed: here when
-- the trainer signs in for the first time, or in onboard_trainer when the login already exists.
-- Only a confirmed email counts, so keep "Confirm email" on in Supabase Auth (README).
create function app_private.link_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null and new.email_confirmed_at is not null then
    update public.trainers set owner_user_id = new.id
     where owner_user_id is null and owner_email = lower(new.email);
  end if;
  return null;
exception when others then
  -- never block a sign-in over this: the owner can still be linked by hand (RUNBOOK)
  raise warning 'link_owner for user %: %', new.id, sqlerrm;
  return null;
end $$;

create trigger link_owner after insert or update of email, email_confirmed_at on auth.users
  for each row execute function app_private.link_owner();

-- One call creates or updates a trainer from the JSON the demo panel copies:
--   select app_private.onboard_trainer($json$ { "slug": "mario-rossi", ... } $json$::jsonb);
-- The JSON is the whole truth for that trainer, so re-run it with every field to change anything.
-- Session types and products missing from it are retired (active = false), never deleted:
-- past bookings keep pointing at them. The weekly availability is replaced as a whole.
create function app_private.onboard_trainer(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  t public.trainers;
  v_email text := lower(nullif(trim(p ->> 'ownerEmail'), ''));
  v_item jsonb;
  v_i int;
begin
  if p is null or jsonb_typeof(p) <> 'object' or nullif(trim(p ->> 'slug'), '') is null or nullif(trim(p ->> 'name'), '') is null then
    raise exception 'onboard_trainer: the JSON needs at least "slug" and "name"';
  end if;
  if p::text like '%<<%>>%' then
    raise exception 'onboard_trainer: replace every <<placeholder>> in the JSON first';
  end if;

  insert into public.trainers as x (slug, name, tagline, template, plan, theme, whatsapp, instagram, domain, owner_email,
    timezone, locale, currency, slot_step_minutes, min_notice_hours, booking_horizon_days, cancel_window_hours,
    bonus_referrer, bonus_referred)
  values (
    lower(trim(p ->> 'slug')), trim(p ->> 'name'), coalesce(p ->> 'tagline', ''),
    coalesce(p ->> 'template', 'studio'), coalesce(p ->> 'plan', 'web'), coalesce(p -> 'theme', '{"brand": "#1F4BFF"}'),
    nullif(regexp_replace(coalesce(p ->> 'whatsapp', ''), '[\s().-]', '', 'g'), ''), nullif(trim(p ->> 'instagram'), ''),
    lower(nullif(trim(p ->> 'domain'), '')), v_email,
    coalesce(p ->> 'timezone', 'Europe/Rome'), coalesce(p ->> 'locale', 'it'), coalesce(p ->> 'currency', 'EUR'),
    coalesce((p ->> 'slotStepMinutes')::int, 30), coalesce((p ->> 'minNoticeHours')::int, 2),
    coalesce((p ->> 'bookingHorizonDays')::int, 28), coalesce((p ->> 'cancelWindowHours')::int, 24),
    coalesce((p ->> 'bonusReferrer')::int, 1), coalesce((p ->> 'bonusReferred')::int, 1)
  )
  on conflict (slug) do update set
    name = excluded.name, tagline = excluded.tagline, template = excluded.template, plan = excluded.plan,
    theme = excluded.theme, whatsapp = excluded.whatsapp, instagram = excluded.instagram, domain = excluded.domain,
    owner_email = excluded.owner_email,
    -- a different owner email moves the admin to that login, or to nobody until it signs in
    owner_user_id = case when x.owner_email is not distinct from excluded.owner_email then x.owner_user_id end,
    timezone = excluded.timezone, locale = excluded.locale, currency = excluded.currency,
    slot_step_minutes = excluded.slot_step_minutes, min_notice_hours = excluded.min_notice_hours,
    booking_horizon_days = excluded.booking_horizon_days, cancel_window_hours = excluded.cancel_window_hours,
    bonus_referrer = excluded.bonus_referrer, bonus_referred = excluded.bonus_referred
  returning * into t;

  -- a login that already exists (for example the trainer's own client account) is linked now
  if t.owner_user_id is null and v_email is not null then
    update public.trainers
       set owner_user_id = (select u.id from auth.users u where lower(u.email) = v_email and u.email_confirmed_at is not null limit 1)
     where id = t.id
    returning * into t;
  end if;

  if jsonb_typeof(p -> 'sessionTypes') = 'array' then
    for v_i in 0 .. jsonb_array_length(p -> 'sessionTypes') - 1 loop
      v_item := p -> 'sessionTypes' -> v_i;
      update public.session_types
         set description = nullif(trim(v_item ->> 'description'), ''), minutes = (v_item ->> 'minutes')::int,
             capacity = coalesce((v_item ->> 'capacity')::int, 1), credits = coalesce((v_item ->> 'credits')::int, 1),
             active = true, sort = v_i
       where trainer_id = t.id and name = trim(v_item ->> 'name');
      if not found then
        insert into public.session_types (trainer_id, name, description, minutes, capacity, credits, sort)
        values (t.id, trim(v_item ->> 'name'), nullif(trim(v_item ->> 'description'), ''), (v_item ->> 'minutes')::int,
                coalesce((v_item ->> 'capacity')::int, 1), coalesce((v_item ->> 'credits')::int, 1), v_i);
      end if;
    end loop;
    update public.session_types set active = false
     where trainer_id = t.id and name not in (select trim(e ->> 'name') from jsonb_array_elements(p -> 'sessionTypes') e);
  end if;

  if jsonb_typeof(p -> 'availability') = 'array' then
    if exists (select 1 from jsonb_array_elements(p -> 'availability') a
                where nullif(trim(a ->> 'sessionType'), '') is not null
                  and not exists (select 1 from public.session_types s
                                   where s.trainer_id = t.id and s.active and s.name = trim(a ->> 'sessionType'))) then
      raise exception 'onboard_trainer: an availability window names a session type that is not in "sessionTypes"';
    end if;
    delete from public.availability where trainer_id = t.id;
    insert into public.availability (trainer_id, weekday, start_time, end_time, location, session_type_id)
    select t.id, (a ->> 'weekday')::int, (a ->> 'start')::time, (a ->> 'end')::time, nullif(trim(a ->> 'location'), ''),
           (select s.id from public.session_types s where s.trainer_id = t.id and s.active and s.name = trim(a ->> 'sessionType'))
      from jsonb_array_elements(p -> 'availability') a;
  end if;

  if jsonb_typeof(p -> 'products') = 'array' then
    for v_i in 0 .. jsonb_array_length(p -> 'products') - 1 loop
      v_item := p -> 'products' -> v_i;
      update public.products
         set description = nullif(trim(v_item ->> 'description'), ''), price_cents = (v_item ->> 'priceCents')::int,
             image_url = nullif(trim(v_item ->> 'imageUrl'), ''), payment_url = trim(v_item ->> 'paymentUrl'),
             active = true, sort = v_i
       where trainer_id = t.id and name = trim(v_item ->> 'name');
      if not found then
        insert into public.products (trainer_id, name, description, price_cents, image_url, payment_url, sort)
        values (t.id, trim(v_item ->> 'name'), nullif(trim(v_item ->> 'description'), ''), (v_item ->> 'priceCents')::int,
                nullif(trim(v_item ->> 'imageUrl'), ''), trim(v_item ->> 'paymentUrl'), v_i);
      end if;
    end loop;
    update public.products set active = false
     where trainer_id = t.id and name not in (select trim(e ->> 'name') from jsonb_array_elements(p -> 'products') e);
  end if;

  return jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'owner', case when t.owner_user_id is not null then 'linked'
                  when t.owner_email is not null then 'links at the trainer''s first sign-in'
                  else 'none: add "ownerEmail"' end,
    'session_types', (select count(*) from public.session_types s where s.trainer_id = t.id and s.active),
    'availability_windows', (select count(*) from public.availability a where a.trainer_id = t.id),
    'products', (select count(*) from public.products pr where pr.trainer_id = t.id and pr.active)
  );
end $$;

-- ── public wrappers: "now" always comes from the database clock ─────────────

create function public.free_slots(p_session_type uuid, p_from date, p_days int)
returns table (starts_at timestamptz, ends_at timestamptz, places_left int, location text)
language sql stable security definer set search_path = '' as $$
  select * from app_private.free_slots(p_session_type, p_from, p_days, now())
$$;

create function public.book_session(p_session_type uuid, p_starts_at timestamptz) returns public.bookings
language sql security definer set search_path = '' as $$
  select * from app_private.book(p_session_type, p_starts_at, now())
$$;

create function public.cancel_booking(p_booking uuid) returns public.bookings
language sql security definer set search_path = '' as $$
  select * from app_private.cancel(p_booking, now())
$$;

create function public.set_attendance(p_booking uuid, p_status text) returns public.bookings
language sql security definer set search_path = '' as $$
  select * from app_private.set_attendance(p_booking, p_status, now())
$$;

-- ── row level security ──────────────────────────────────────────────────────

alter table public.trainers enable row level security;
alter table public.clients enable row level security;
alter table public.session_types enable row level security;
alter table public.availability enable row level security;
alter table public.time_off enable row level security;
alter table public.bookings enable row level security;
alter table public.pack_purchases enable row level security;
alter table public.referrals enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.products enable row level security;

create policy trainers_owner_read on public.trainers for select to authenticated using (owner_user_id = auth.uid());
create policy clients_read on public.clients for select to authenticated
  using (user_id = auth.uid() or app_private.is_owner(trainer_id));
create policy session_types_read on public.session_types for select to anon, authenticated using (active or app_private.is_owner(trainer_id));
create policy session_types_owner on public.session_types for all to authenticated
  using (app_private.is_owner(trainer_id)) with check (app_private.is_owner(trainer_id));
create policy availability_owner on public.availability for all to authenticated
  using (app_private.is_owner(trainer_id)) with check (app_private.is_owner(trainer_id));
create policy time_off_owner on public.time_off for all to authenticated
  using (app_private.is_owner(trainer_id)) with check (app_private.is_owner(trainer_id));
create policy bookings_read on public.bookings for select to authenticated
  using (client_id = app_private.my_client_id(trainer_id) or app_private.is_owner(trainer_id));
create policy packs_read on public.pack_purchases for select to authenticated
  using (client_id = app_private.my_client_id(trainer_id) or app_private.is_owner(trainer_id));
create policy ledger_read on public.credit_ledger for select to authenticated
  using (client_id = app_private.my_client_id(trainer_id) or app_private.is_owner(trainer_id));
-- clients see their own invites through public.my_referrals(), never other people's names
create policy referrals_owner_read on public.referrals for select to authenticated using (app_private.is_owner(trainer_id));
create policy products_read on public.products for select to anon, authenticated using (active or app_private.is_owner(trainer_id));
create policy products_owner on public.products for all to authenticated
  using (app_private.is_owner(trainer_id)) with check (app_private.is_owner(trainer_id));

-- ── privileges ──────────────────────────────────────────────────────────────

grant usage on schema app_private to anon, authenticated;
revoke execute on all functions in schema app_private from public, anon, authenticated;
grant execute on function app_private.is_owner(uuid), app_private.my_client_id(uuid) to anon, authenticated;

revoke execute on function
  public.trainer_book(uuid, uuid, timestamptz),
  public.mark_pack_paid(uuid, int, int, text, text, uuid),
  public.void_pack(uuid),
  public.adjust_credits(uuid, int, text, uuid),
  public.reverse_referral(uuid),
  public.join_trainer(uuid, text, text, text, boolean),
  public.trainer_add_client(uuid, text, text, text),
  public.my_referrals(uuid),
  public.delete_my_account(uuid),
  public.free_slots(uuid, date, int),
  public.book_session(uuid, timestamptz),
  public.cancel_booking(uuid),
  public.set_attendance(uuid, text)
from public, anon;
grant execute on function
  public.trainer_book(uuid, uuid, timestamptz),
  public.mark_pack_paid(uuid, int, int, text, text, uuid),
  public.void_pack(uuid),
  public.adjust_credits(uuid, int, text, uuid),
  public.reverse_referral(uuid),
  public.join_trainer(uuid, text, text, text, boolean),
  public.trainer_add_client(uuid, text, text, text),
  public.my_referrals(uuid),
  public.delete_my_account(uuid),
  public.free_slots(uuid, date, int),
  public.book_session(uuid, timestamptz),
  public.cancel_booking(uuid),
  public.set_attendance(uuid, text)
to authenticated;
grant execute on function public.trainer_public(text) to anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
revoke insert, update, delete on public.trainers, public.clients, public.bookings, public.pack_purchases,
  public.referrals, public.credit_ledger from anon, authenticated;
grant insert, update, delete on public.availability, public.time_off, public.products to authenticated;
-- a session type with bookings cannot be deleted (their history points at it): retire it with active = false
grant insert, update on public.session_types to authenticated;
revoke delete on public.session_types from anon, authenticated;
-- Supabase's default grants also give the API roles table rights the app never uses: take them back
revoke insert, update, delete on public.availability, public.time_off, public.products, public.session_types from anon;
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Functions added by later migrations start closed: grant each one explicitly, like the ones above.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ── storage: a public bucket for trainer logos, covers and product photos ───
-- Files go in through the Supabase dashboard (Storage > brand); everyone can read them,
-- so the theme's https URLs work in every app. Skipped where there is no Supabase Storage.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('brand', 'brand', true) on conflict (id) do nothing;
  end if;
end $$;
