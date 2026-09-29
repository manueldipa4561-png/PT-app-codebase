-- App opens per trainer and day, for the numbers in the trainer's "this month" panel. Anonymous on
-- purpose: no user, no IP, no cookie, so the app still needs no consent banner (docs/GDPR.md).
-- Only log_visit() writes; only the trainer who owns the app reads.

create table public.app_visits (
  trainer_id uuid not null references public.trainers (id) on delete cascade,
  day date not null,
  opens int not null default 0 check (opens >= 0),
  installed int not null default 0 check (installed between 0 and opens),
  primary key (trainer_id, day)
);

alter table public.app_visits enable row level security;
create policy app_visits_owner_read on public.app_visits for select to authenticated using (app_private.is_owner(trainer_id));
revoke all on public.app_visits from anon, authenticated;
grant select on public.app_visits to authenticated;

-- One app open, on the trainer's calendar day. Callable signed out: opening the app before joining counts too.
-- ponytail: anyone can add opens, so a flood could inflate the count; add a per-IP limit if that ever matters.
create function public.log_visit(p_trainer uuid, p_installed boolean) returns void
language sql security definer set search_path = '' as $$
  insert into public.app_visits as v (trainer_id, day, opens, installed)
  select t.id, (now() at time zone t.timezone)::date, 1, case when p_installed then 1 else 0 end
    from public.trainers t
   where t.id = p_trainer
  on conflict (trainer_id, day) do update set opens = v.opens + 1, installed = v.installed + excluded.installed;
$$;
grant execute on function public.log_visit(uuid, boolean) to anon, authenticated;
