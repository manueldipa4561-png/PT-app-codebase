-- Three loose ends of the waitlist, found in review.
--  1. A client who books the time they were waiting for, and later cancels it, came back onto the list at their old
--     place, "waiting" for a session they had just given up. Booking a time now takes the client off the list for it,
--     whoever books (the client, the trainer, a move).
--  2. An erased client leaves nothing on the list.
--  3. The list showed entries of a session type that was retired, and said a place was open that no one can book.
-- Also: the list now starts from the caller's own entries, so a client costs only their own sessions.

create function app_private.waitlist_clear_booked() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.waitlist w where w.client_id = new.client_id and w.starts_at = new.starts_at;
  return null;
end $$;

create trigger waitlist_clear_booked after insert on public.bookings
  for each row when (new.status = 'booked') execute function app_private.waitlist_clear_booked();

create function app_private.waitlist_clear_erased() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.waitlist w where w.client_id = new.id;
  return null;
end $$;

create trigger waitlist_clear_erased after update of deleted_at on public.clients
  for each row when (new.deleted_at is not null and old.deleted_at is null) execute function app_private.waitlist_clear_erased();

create or replace function app_private.waitlist_entries(p_trainer uuid, p_now timestamptz)
returns table (id uuid, trainer_id uuid, client_id uuid, session_type_id uuid, starts_at timestamptz, created_at timestamptz, open boolean, "position" int)
language sql stable security definer set search_path = '' as $$
  with viewer as (
    select app_private.is_owner(p_trainer) as is_owner, app_private.my_client_id(p_trainer) as client_id
  ),
  -- the sessions the caller cares about: all of them for the owner, for a client only the ones they wait for. Each
  -- builds a whole day of slots, and this runs every few seconds on every open app.
  slots as (
    select s.session_type_id, s.starts_at, c.places_left, tr.min_notice_hours
    from (
      select w.session_type_id, w.starts_at from public.waitlist w, viewer v
       where v.is_owner and w.trainer_id = p_trainer and w.starts_at > p_now
      union
      select w.session_type_id, w.starts_at from public.waitlist w, viewer v
       where w.client_id = v.client_id and w.starts_at > p_now
    ) s
    join public.session_types st on st.id = s.session_type_id and st.active
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

-- Said out loud, as in the migrations before: a new function in app_private starts open to everyone.
revoke execute on function
  app_private.waitlist_clear_booked(),
  app_private.waitlist_clear_erased(),
  app_private.waitlist_entries(uuid, timestamptz)
from public, anon, authenticated;
