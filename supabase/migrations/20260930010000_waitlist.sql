-- Waitlist: a client waits for a place in a session that is full. The list holds no place and sends nothing: a place
-- that opens (a cancellation, a move) is free for everyone, and the trainer sees who was waiting and writes to them.
-- Whether a place is free, and who is first in line, is worked out when the list is read, so booking, cancelling and
-- moving never touch this table.

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  client_id uuid not null,
  session_type_id uuid not null,
  starts_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (trainer_id, client_id) references public.clients (trainer_id, id) on delete cascade,
  foreign key (trainer_id, session_type_id) references public.session_types (trainer_id, id) on delete cascade,
  unique (client_id, session_type_id, starts_at)
);
create index waitlist_trainer_start on public.waitlist (trainer_id, starts_at);

-- Only the functions below read or write it: no policy, no table rights for the API roles.
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- ── full slots: the ones a client can wait for ──────────────────────────────

-- Like free_slots, for the slots with no place left. Never the ones this client already holds.
create function app_private.full_slots(p_type uuid, p_from date, p_days int, p_now timestamptz)
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
      and c.places_left = 0
      and c.starts_at >= p_now + make_interval(hours => t.min_notice_hours)
      and c.starts_at <= p_now + make_interval(days => t.booking_horizon_days)
      and not exists (
        select 1 from public.bookings b
        where b.client_id = app_private.my_client_id(t.id) and b.starts_at = c.starts_at and b.status = 'booked'
      );
end $$;

-- ── joining and leaving ─────────────────────────────────────────────────────

-- The checks of a booking, in the same order, except that the place must be taken: a free place is booked, not waited for.
create function app_private.join_waitlist(p_type uuid, p_starts_at timestamptz, p_now timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  st public.session_types;
  t public.trainers;
  v_client uuid;
  c record;
begin
  select * into st from public.session_types where id = p_type and active;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into t from public.trainers where id = st.trainer_id;
  v_client := app_private.my_client_id(t.id);
  if v_client is null then raise exception 'NOT_ALLOWED'; end if;

  if exists (select 1 from public.waitlist w where w.client_id = v_client and w.session_type_id = p_type and w.starts_at = p_starts_at) then
    return; -- a retry of the same request
  end if;

  if p_starts_at < p_now + make_interval(hours => t.min_notice_hours) then raise exception 'TOO_SOON'; end if;
  if p_starts_at > p_now + make_interval(days => t.booking_horizon_days) then raise exception 'TOO_FAR'; end if;
  select * into c from app_private.slot_candidates(p_type, (p_starts_at at time zone t.timezone)::date, 1) s
   where s.starts_at = p_starts_at;
  if not found or c.in_time_off then raise exception 'OUTSIDE_HOURS'; end if;
  if c.places_left > 0 then raise exception 'SLOT_OPEN'; end if;
  if exists (select 1 from public.bookings b where b.client_id = v_client and b.starts_at = p_starts_at and b.status = 'booked') then
    raise exception 'INVALID_INPUT'; -- they already hold this session
  end if;

  -- rows only come in through here, so this is where the old ones go
  delete from public.waitlist w where w.trainer_id = t.id and w.starts_at < p_now - interval '1 day';
  insert into public.waitlist (trainer_id, client_id, session_type_id, starts_at)
  values (t.id, v_client, p_type, p_starts_at)
  on conflict (client_id, session_type_id, starts_at) do nothing;
end $$;

-- Leaving is the client's own and quiet: an entry that is gone, or not theirs, changes nothing.
create function public.leave_waitlist(p_entry uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.waitlist w using public.clients c
   where w.id = p_entry and c.id = w.client_id and c.user_id = auth.uid()
$$;

-- ── reading ─────────────────────────────────────────────────────────────────

-- The waiting list as the caller may see it: the owner sees everyone's, a client only their own. Only entries that
-- still mean something: the session is ahead and still offered, nobody here already holds it. Each says whether a
-- place is free now ("open": for a client also outside the minimum notice, the trainer can book at any hour) and
-- the place in line, first come first served.
create function app_private.waitlist_entries(p_trainer uuid, p_now timestamptz)
returns table (id uuid, trainer_id uuid, client_id uuid, session_type_id uuid, starts_at timestamptz, created_at timestamptz, open boolean, "position" int)
language sql stable security definer set search_path = '' as $$
  with viewer as (
    select app_private.is_owner(p_trainer) as is_owner, app_private.my_client_id(p_trainer) as client_id
  ),
  -- the sessions the caller cares about: all of them for the owner, the ones they wait for for a client (this runs
  -- every few seconds on every open app, and a client with no entry costs nothing)
  slots as (
    select s.session_type_id, s.starts_at, c.places_left, tr.min_notice_hours
    from (
      select distinct w.session_type_id, w.starts_at
      from public.waitlist w cross join viewer v
      where w.trainer_id = p_trainer and w.starts_at > p_now
        and (v.is_owner or exists (
          select 1 from public.waitlist m
          where m.client_id = v.client_id and m.session_type_id = w.session_type_id and m.starts_at = w.starts_at
        ))
    ) s
    join public.trainers tr on tr.id = p_trainer
    cross join lateral app_private.slot_candidates(s.session_type_id, (s.starts_at at time zone tr.timezone)::date, 1) c
    where c.starts_at = s.starts_at and not c.in_time_off
  ),
  live as (
    select w.id, w.trainer_id, w.client_id, w.session_type_id, w.starts_at, w.created_at, s.places_left, s.min_notice_hours,
           (row_number() over (partition by w.session_type_id, w.starts_at order by w.created_at, w.id))::int as place
    from public.waitlist w
    join slots s on s.session_type_id = w.session_type_id and s.starts_at = w.starts_at
    join public.clients cl on cl.id = w.client_id and cl.deleted_at is null
    where w.trainer_id = p_trainer
      and not exists (
        select 1 from public.bookings b where b.client_id = w.client_id and b.starts_at = w.starts_at and b.status = 'booked'
      )
  )
  select l.id, l.trainer_id, l.client_id, l.session_type_id, l.starts_at, l.created_at,
         l.places_left > 0 and (v.is_owner or l.starts_at >= p_now + make_interval(hours => l.min_notice_hours)),
         l.place
  from live l cross join viewer v
  where v.is_owner or l.client_id = v.client_id
  order by l.starts_at, l.place, l.session_type_id, l.id
$$;

-- ── public wrappers: "now" always comes from the database clock ─────────────

create function public.full_slots(p_session_type uuid, p_from date, p_days int)
returns table (starts_at timestamptz, ends_at timestamptz, places_left int, location text)
language sql stable security definer set search_path = '' as $$
  select * from app_private.full_slots(p_session_type, p_from, p_days, now())
$$;

create function public.join_waitlist(p_session_type uuid, p_starts_at timestamptz) returns void
language sql security definer set search_path = '' as $$
  select app_private.join_waitlist(p_session_type, p_starts_at, now())
$$;

create function public.waitlist_entries(p_trainer uuid)
returns table (id uuid, trainer_id uuid, client_id uuid, session_type_id uuid, starts_at timestamptz, created_at timestamptz, open boolean, "position" int)
language sql stable security definer set search_path = '' as $$
  select * from app_private.waitlist_entries(p_trainer, now())
$$;

-- The internal functions take "now" as an argument: only the public wrappers may call them, never a client.
-- Said out loud here because a role that did not run the first migration has other default privileges.
revoke execute on function
  app_private.full_slots(uuid, date, int, timestamptz),
  app_private.join_waitlist(uuid, timestamptz, timestamptz),
  app_private.waitlist_entries(uuid, timestamptz)
from public, anon, authenticated;
revoke execute on function
  public.full_slots(uuid, date, int),
  public.join_waitlist(uuid, timestamptz),
  public.leave_waitlist(uuid),
  public.waitlist_entries(uuid)
from public, anon;
grant execute on function
  public.full_slots(uuid, date, int),
  public.join_waitlist(uuid, timestamptz),
  public.leave_waitlist(uuid),
  public.waitlist_entries(uuid)
to authenticated;
