alter table public.author_lifetime_boosts
  add column if not exists admin_event_paused_at timestamptz,
  add column if not exists admin_event_remaining_seconds bigint,
  add column if not exists admin_event_pause_cycle_id uuid references public.author_100_percent_event_cycles(id) on delete restrict;

create index if not exists author_lifetime_boosts_admin_event_pause_idx
  on public.author_lifetime_boosts(admin_event_pause_cycle_id)
  where admin_event_pause_cycle_id is not null;
