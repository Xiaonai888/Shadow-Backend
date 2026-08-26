create table if not exists public.task_center_reading_mission_manual_state (
  mission_id uuid primary key references public.task_center_reading_missions(id) on delete cascade,
  is_active boolean not null default false,
  title text not null default '',
  subtitle text not null default '',
  reward_coins integer not null default 0,
  target_minutes integer not null default 1,
  story_link text not null default '',
  button_text text not null default 'Go',
  sort_order integer not null default 0,
  saved_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.task_center_reading_mission_manual_state enable row level security;

revoke all on table public.task_center_reading_mission_manual_state from anon, authenticated;

create or replace function public.save_task_center_manual_mission_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_mode text;
begin
  select coalesce(reading_mission_mode, 'manual')
  into current_mode
  from public.task_center_settings
  where setting_key = 'main';

  if coalesce(current_mode, 'manual') <> 'manual' then
    return new;
  end if;

  insert into public.task_center_reading_mission_manual_state (
    mission_id,
    is_active,
    title,
    subtitle,
    reward_coins,
    target_minutes,
    story_link,
    button_text,
    sort_order,
    saved_at,
    updated_at
  )
  values (
    new.id,
    coalesce(new.is_active, false),
    coalesce(new.title, ''),
    coalesce(new.subtitle, ''),
    coalesce(new.reward_coins, 0),
    greatest(1, coalesce(new.target_minutes, 1)),
    coalesce(new.story_link, ''),
    coalesce(new.button_text, 'Go'),
    coalesce(new.sort_order, 0),
    now(),
    now()
  )
  on conflict (mission_id)
  do update set
    is_active = excluded.is_active,
    title = excluded.title,
    subtitle = excluded.subtitle,
    reward_coins = excluded.reward_coins,
    target_minutes = excluded.target_minutes,
    story_link = excluded.story_link,
    button_text = excluded.button_text,
    sort_order = excluded.sort_order,
    saved_at = excluded.saved_at,
    updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists trg_task_center_save_manual_mission_state
on public.task_center_reading_missions;

create trigger trg_task_center_save_manual_mission_state
after insert or update
on public.task_center_reading_missions
for each row
execute function public.save_task_center_manual_mission_state();

create or replace function public.restore_task_center_manual_mission_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.reading_mission_mode, 'manual') = 'auto'
     and coalesce(new.reading_mission_mode, 'manual') = 'manual' then

    update public.task_center_reading_missions as mission
    set
      is_active = state.is_active,
      title = state.title,
      subtitle = state.subtitle,
      reward_coins = state.reward_coins,
      target_minutes = state.target_minutes,
      story_link = state.story_link,
      button_text = state.button_text,
      sort_order = state.sort_order,
      updated_at = now()
    from public.task_center_reading_mission_manual_state as state
    where state.mission_id = mission.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_task_center_restore_manual_mission_state
on public.task_center_settings;

create trigger trg_task_center_restore_manual_mission_state
after update of reading_mission_mode
on public.task_center_settings
for each row
execute function public.restore_task_center_manual_mission_state();

insert into public.task_center_reading_mission_manual_state (
  mission_id,
  is_active,
  title,
  subtitle,
  reward_coins,
  target_minutes,
  story_link,
  button_text,
  sort_order,
  saved_at,
  updated_at
)
select
  mission.id,
  coalesce(mission.is_active, false),
  coalesce(mission.title, ''),
  coalesce(mission.subtitle, ''),
  coalesce(mission.reward_coins, 0),
  greatest(1, coalesce(mission.target_minutes, 1)),
  coalesce(mission.story_link, ''),
  coalesce(mission.button_text, 'Go'),
  coalesce(mission.sort_order, 0),
  now(),
  now()
from public.task_center_reading_missions as mission
where coalesce(
  (
    select settings.reading_mission_mode
    from public.task_center_settings as settings
    where settings.setting_key = 'main'
    limit 1
  ),
  'manual'
) = 'manual'
on conflict (mission_id)
do update set
  is_active = excluded.is_active,
  title = excluded.title,
  subtitle = excluded.subtitle,
  reward_coins = excluded.reward_coins,
  target_minutes = excluded.target_minutes,
  story_link = excluded.story_link,
  button_text = excluded.button_text,
  sort_order = excluded.sort_order,
  saved_at = excluded.saved_at,
  updated_at = excluded.updated_at;
