create table if not exists public.task_center_selection_history (
  id bigint generated always as identity primary key,
  audience text not null check (audience in ('khmer', 'international')),
  selection_date date not null,
  selected_at timestamptz not null default now(),
  mission_id text not null,
  slot smallint,
  story_id text not null,
  story_link text not null,
  story_title text,
  selection_mode text not null check (selection_mode in ('auto', 'manual')),
  selection_reason text not null check (selection_reason in ('created', 'changed', 'activated', 'reconfirmed'))
);

create index if not exists task_center_selection_history_date_idx
  on public.task_center_selection_history (audience, selection_date desc, selected_at desc);

create index if not exists task_center_selection_history_story_idx
  on public.task_center_selection_history (audience, story_id, selected_at desc);

create index if not exists task_center_selection_history_mission_idx
  on public.task_center_selection_history (mission_id, selected_at desc);

alter table public.task_center_selection_history enable row level security;
revoke all on table public.task_center_selection_history from anon, authenticated;

create or replace function public.capture_task_center_selection_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  chosen_id text;
  chosen_mode text;
  previous_date date;
  current_date_kh date;
  reason text;
  actual_time timestamptz;
begin
  if coalesce(new.audience, '') not in ('khmer', 'international')
     or coalesce(new.is_active, false) is false then
    return new;
  end if;

  chosen_id := substring(coalesce(new.story_link, '') from '/story/([^/?#]+)');
  if chosen_id is null or btrim(chosen_id) = '' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.story_link is not distinct from old.story_link
       and new.is_active is not distinct from old.is_active
       and new.updated_at is not distinct from old.updated_at then
      return new;
    end if;
  end if;

  select case
    when new.audience = 'international' then coalesce(international_reading_mission_mode, 'manual')
    else coalesce(reading_mission_mode, 'manual')
  end
  into chosen_mode
  from public.task_center_settings
  where setting_key = 'main';

  chosen_mode := case when chosen_mode = 'auto' then 'auto' else 'manual' end;

  if tg_op = 'UPDATE' and chosen_mode = 'auto' then
    if new.story_link is not distinct from old.story_link
       and new.is_active is not distinct from old.is_active
       and (new.reward_coins is distinct from old.reward_coins
         or new.target_minutes is distinct from old.target_minutes) then
      return new;
    end if;
  end if;

  actual_time := clock_timestamp();
  current_date_kh := (actual_time at time zone 'Asia/Phnom_Penh')::date;

  select selection_date
  into previous_date
  from public.task_center_selection_history
  where mission_id = new.id::text
  order by selected_at desc, id desc
  limit 1;

  if tg_op = 'INSERT' then
    reason := 'created';
  elsif new.story_link is distinct from old.story_link then
    reason := 'changed';
  elsif coalesce(old.is_active, false) is false then
    reason := 'activated';
  elsif previous_date is distinct from current_date_kh then
    reason := 'reconfirmed';
  else
    return new;
  end if;

  insert into public.task_center_selection_history (
    audience, selection_date, selected_at, mission_id, slot,
    story_id, story_link, story_title, selection_mode, selection_reason
  )
  values (
    new.audience,
    current_date_kh,
    actual_time,
    new.id::text,
    case when new.sort_order in (0, 1) then (new.sort_order + 1)::smallint else null end,
    chosen_id,
    left(new.story_link, 500),
    nullif(left(btrim(coalesce(new.subtitle, '')), 240), ''),
    chosen_mode,
    reason
  );

  return new;
end;
$$;

revoke all on function public.capture_task_center_selection_history() from public, anon, authenticated;

drop trigger if exists trg_capture_task_center_selection_history on public.task_center_reading_missions;

create trigger trg_capture_task_center_selection_history
  after insert or update on public.task_center_reading_missions
  for each row
  execute function public.capture_task_center_selection_history();

create or replace view public.task_center_selection_history_view as
with combined as (
  select
    'event:' || h.id::text as id,
    h.audience,
    h.selection_date,
    h.selected_at,
    h.mission_id,
    h.slot,
    h.story_id,
    h.story_link,
    h.story_title,
    h.selection_mode,
    h.selection_reason,
    null::text as auto_source
  from public.task_center_selection_history h
  union all
  select
    'legacy-khmer:' || h.id::text,
    'khmer'::text,
    h.featured_date,
    h.selected_at,
    h.mission_id,
    h.slot,
    h.story_id,
    '/story/' || h.story_id,
    null::text,
    'auto'::text,
    'created'::text,
    h.selection_source
  from public.task_center_auto_story_history h
  where not exists (
    select 1 from public.task_center_selection_history e
    where e.audience = 'khmer'
      and e.selection_date = h.featured_date
      and e.story_id = h.story_id
      and e.mission_id = h.mission_id
      and e.selection_mode = 'auto'
  )
  union all
  select
    'legacy-international:' || h.id::text,
    'international'::text,
    h.featured_date,
    h.selected_at,
    h.mission_id,
    h.slot,
    h.story_id,
    '/story/' || h.story_id,
    null::text,
    'auto'::text,
    'created'::text,
    h.selection_source
  from public.task_center_international_auto_story_history h
  where not exists (
    select 1 from public.task_center_selection_history e
    where e.audience = 'international'
      and e.selection_date = h.featured_date
      and e.story_id = h.story_id
      and e.mission_id = h.mission_id
      and e.selection_mode = 'auto'
  )
), history as (
  select
    combined.*,
    lag(selection_date) over (
      partition by audience, story_id
      order by selected_at, id
    ) as previous_selection_date
  from combined
)
select
  id, audience, selection_date, selected_at, mission_id, slot,
  story_id, story_link, story_title, selection_mode,
  selection_reason, auto_source, previous_selection_date,
  (previous_selection_date is not null) as is_repeat
from history;

revoke all on table public.task_center_selection_history_view from anon, authenticated;
