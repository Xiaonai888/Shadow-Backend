begin;

alter table public.task_center_smart_auto_state
  add column if not exists exposure_history jsonb not null default '[]'::jsonb
  check (jsonb_typeof(exposure_history) = 'array' and jsonb_array_length(exposure_history) <= 64);

create or replace function public.task_center_smart_auto_record_exposure_v1(
  p_reader_id text,
  p_visible_missions jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.task_center_smart_auto_state%rowtype;
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_history jsonb;
  v_item jsonb;
  v_story text;
  v_window bigint;
begin
  if p_reader_id is null or length(p_reader_id) not between 1 and 128 or p_visible_missions is null or jsonb_typeof(p_visible_missions) <> 'array' then
    raise exception 'Invalid Smart Auto exposure input';
  end if;
  if jsonb_array_length(p_visible_missions) > 2 then
    raise exception 'Too many Smart Auto exposures';
  end if;
  select * into v_row from public.task_center_smart_auto_state where reader_id = p_reader_id for update;
  if not found then return false; end if;
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_history
  from jsonb_array_elements(v_row.exposure_history) e
  where (e->>'seenAt')::bigint >= v_now - 604800000;
  for v_item in select value from jsonb_array_elements(p_visible_missions) loop
    if jsonb_typeof(v_item->'storyId') is distinct from 'string' or jsonb_typeof(v_item->'windowStart') is distinct from 'number' then continue; end if;
    v_story := v_item->>'storyId';
    if length(v_story) not between 1 and 128 or (v_item->>'windowStart') !~ '^[0-9]{1,15}$' then continue; end if;
    v_window := (v_item->>'windowStart')::bigint;
    if not exists (
      select 1 from jsonb_array_elements(v_row.missions) m
      where m->>'storyId' = v_story and m->>'windowStart' = v_window::text
        and m->>'status' in ('assigned','in_progress','claimable','claimed')
    ) then continue; end if;
    if exists (select 1 from jsonb_array_elements(v_history) e where e->>'storyId' = v_story and (e->>'windowStart')::bigint = v_window) then continue; end if;
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_history from jsonb_array_elements(v_history) e where e->>'storyId' <> v_story;
    v_history := v_history || jsonb_build_array(jsonb_build_object('storyId', v_story, 'windowStart', v_window, 'seenAt', v_now));
  end loop;
  select coalesce(jsonb_agg(e order by (e->>'seenAt')::bigint desc, e->>'storyId'), '[]'::jsonb) into v_history
  from (select e from jsonb_array_elements(v_history) e order by (e->>'seenAt')::bigint desc, e->>'storyId' limit 64) bounded;
  if v_history is distinct from v_row.exposure_history then
    update public.task_center_smart_auto_state set exposure_history = v_history where reader_id = p_reader_id;
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.task_center_smart_auto_record_exposure_v1(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.task_center_smart_auto_record_exposure_v1(text,jsonb) to service_role;

commit;
