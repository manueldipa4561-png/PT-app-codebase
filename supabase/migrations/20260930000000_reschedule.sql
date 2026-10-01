-- A client moves their own session to another slot, in one step. Moving is a free cancellation plus a
-- new booking, so it is only allowed while a free cancellation still is (outside the cancel window). One
-- transaction: if the new slot is taken or outside the hours, the old session is exactly as it was.

create function app_private.reschedule(p_booking uuid, p_starts_at timestamptz, p_now timestamptz)
returns public.bookings
language plpgsql security definer set search_path = '' as $$
declare
  old public.bookings;
  t public.trainers;
begin
  select * into old from public.bookings where id = p_booking for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into t from public.trainers where id = old.trainer_id;
  if old.client_id is distinct from app_private.my_client_id(t.id) then raise exception 'NOT_ALLOWED'; end if;
  if old.status <> 'booked' or p_now >= old.starts_at then raise exception 'NOT_ALLOWED'; end if;
  -- inside the cancel window a cancellation costs the session, and so would a move: the client asks the trainer
  if old.starts_at - p_now < make_interval(hours => t.cancel_window_hours) then raise exception 'NOT_ALLOWED'; end if;

  -- release the old session (its credit comes back), then book the new one with the usual rules
  perform app_private.cancel(p_booking, p_now);
  return app_private.book(old.session_type_id, p_starts_at, p_now);
end $$;

create function public.reschedule_booking(p_booking uuid, p_starts_at timestamptz) returns public.bookings
language sql security definer set search_path = '' as $$
  select * from app_private.reschedule(p_booking, p_starts_at, now())
$$;

-- The internal function takes "now" as an argument: only the public wrapper may call it, never a client.
-- Said out loud here because a role that did not run the first migration has other default privileges.
revoke execute on function app_private.reschedule(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.reschedule_booking(uuid, timestamptz) from public, anon;
grant execute on function public.reschedule_booking(uuid, timestamptz) to authenticated;
