create extension if not exists pg_cron with schema pg_catalog;

alter table public.fast_videos
  add column if not exists youtube_health_state text not null default 'unchecked',
  add column if not exists youtube_health_checked_at timestamptz,
  add column if not exists youtube_health_due_at timestamptz default now(),
  add column if not exists youtube_health_missing_count smallint not null default 0,
  add column if not exists youtube_unavailable_since timestamptz,
  add column if not exists youtube_restore_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fast_videos'::regclass
      and conname = 'fast_videos_youtube_health_state_check'
  ) then
    alter table public.fast_videos
      add constraint fast_videos_youtube_health_state_check
      check (youtube_health_state in ('unchecked', 'live', 'suspected', 'unavailable'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fast_videos'::regclass
      and conname = 'fast_videos_youtube_restore_status_check'
  ) then
    alter table public.fast_videos
      add constraint fast_videos_youtube_restore_status_check
      check (youtube_restore_status is null or youtube_restore_status in ('draft', 'published'));
  end if;
end;
$$;

create index if not exists fast_videos_youtube_health_due_idx
  on public.fast_videos (youtube_health_due_at, id)
  where studio_state = 'active' and platform = 'youtube';

create index if not exists fast_videos_youtube_unavailable_owner_idx
  on public.fast_videos (user_id, youtube_unavailable_since desc, id desc)
  where youtube_health_state = 'unavailable' and studio_state = 'active';

create index if not exists fast_videos_youtube_unavailable_cleanup_idx
  on public.fast_videos (youtube_unavailable_since, id)
  where youtube_health_state = 'unavailable' and studio_state = 'active';

create or replace function public.shadow_studio_claim_youtube_health(p_limit integer default 25)
returns table (video_id uuid, video_url text, lease_due_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid YouTube health batch size';
  end if;

  return query
  with due as (
    select fv.id
    from public.fast_videos fv
    where fv.platform = 'youtube'
      and fv.studio_state = 'active'
      and (fv.status = 'published' or fv.youtube_health_state in ('suspected', 'unavailable'))
      and fv.youtube_health_due_at <= clock_timestamp()
    order by fv.youtube_health_due_at asc, fv.id asc
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.fast_videos fv
    set youtube_health_due_at = clock_timestamp() + interval '10 minutes'
    where fv.id in (select id from due)
    returning fv.id, fv.video_url, fv.youtube_health_due_at
  )
  select c.id, c.video_url, c.youtube_health_due_at from claimed c;
end;
$$;

create or replace function public.shadow_studio_apply_youtube_health(
  p_video uuid,
  p_lease_due_at timestamptz,
  p_result text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.fast_videos%rowtype;
  v_now timestamptz := clock_timestamp();
  v_failures integer;
begin
  if p_result not in ('live', 'missing', 'unknown') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESULT');
  end if;

  select * into v
  from public.fast_videos
  where id = p_video
    and studio_state = 'active'
    and platform = 'youtube'
    and youtube_health_due_at = p_lease_due_at
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'STALE_LEASE');
  end if;

  if p_result = 'unknown' then
    update public.fast_videos
    set youtube_health_due_at = v_now + interval '2 hours'
    where id = p_video;
    return jsonb_build_object('ok', true, 'owner_id', v.user_id, 'state', v.youtube_health_state, 'changed', false);
  end if;

  if p_result = 'live' then
    update public.fast_videos
    set youtube_health_state = 'live',
        youtube_health_missing_count = 0,
        youtube_health_checked_at = v_now,
        youtube_health_due_at = v_now + interval '24 hours',
        youtube_unavailable_since = null,
        status = case
          when v.youtube_health_state = 'unavailable'
            and v.youtube_restore_status = 'published'
            and v.status = 'draft' then 'published'
          else v.status
        end,
        youtube_restore_status = null
    where id = p_video;
    return jsonb_build_object('ok', true, 'owner_id', v.user_id, 'state', 'live',
      'changed', v.youtube_health_state = 'unavailable');
  end if;

  v_failures := least(10, v.youtube_health_missing_count::integer + 1);

  if v_failures >= 2 then
    update public.fast_videos
    set youtube_health_state = 'unavailable',
        youtube_health_missing_count = v_failures,
        youtube_health_checked_at = v_now,
        youtube_health_due_at = v_now + interval '24 hours',
        youtube_unavailable_since = coalesce(v.youtube_unavailable_since, v_now),
        youtube_restore_status = case
          when v.youtube_health_state = 'unavailable' then v.youtube_restore_status
          else v.status
        end,
        status = 'draft'
    where id = p_video;
    return jsonb_build_object('ok', true, 'owner_id', v.user_id, 'state', 'unavailable',
      'changed', v.youtube_health_state <> 'unavailable');
  end if;

  update public.fast_videos
  set youtube_health_state = 'suspected',
      youtube_health_missing_count = v_failures,
      youtube_health_checked_at = v_now,
      youtube_health_due_at = v_now + interval '24 hours'
  where id = p_video;
  return jsonb_build_object('ok', true, 'owner_id', v.user_id, 'state', 'suspected',
    'changed', v.youtube_health_state <> 'suspected');
end;
$$;

create or replace function public.shadow_studio_youtube_unavailable_to_trash(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'Invalid unavailable cleanup batch size';
  end if;

  with due as (
    select id
    from public.fast_videos
    where studio_state = 'active'
      and platform = 'youtube'
      and youtube_health_state = 'unavailable'
      and youtube_health_missing_count >= 2
      and youtube_unavailable_since <= v_now - interval '30 days'
      and youtube_health_checked_at >= v_now - interval '48 hours'
    order by youtube_unavailable_since, id
    for update skip locked
    limit p_limit
  ), moved as (
    update public.fast_videos fv
    set studio_state = 'trashed',
        studio_restore_status = coalesce(fv.youtube_restore_status, 'draft'),
        studio_trashed_from = 'active',
        deleted_at = v_now,
        purge_at = v_now + interval '30 days',
        youtube_health_due_at = null,
        status = 'draft'
    where fv.id in (select id from due)
    returning fv.id
  )
  select count(*) into v_count from moved;

  return v_count;
end;
$$;

create or replace function public.shadow_studio_youtube_status_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.video_url is distinct from old.video_url then
      new.youtube_health_state := 'unchecked';
      new.youtube_health_checked_at := null;
      new.youtube_health_due_at := clock_timestamp();
      new.youtube_health_missing_count := 0;
      new.youtube_unavailable_since := null;
      new.youtube_restore_status := null;
    end if;

    if old.studio_state is distinct from new.studio_state
       and new.studio_state = 'active'
       and new.youtube_health_due_at is null then
      new.youtube_health_due_at := clock_timestamp();
    end if;
  end if;

  if new.platform = 'youtube'
     and new.youtube_health_state = 'unavailable'
     and new.status = 'published' then
    new.status := 'draft';
  end if;
  return new;
end;
$$;

drop trigger if exists fast_videos_youtube_status_guard on public.fast_videos;
create trigger fast_videos_youtube_status_guard
before insert or update of status, studio_state, video_url
on public.fast_videos
for each row execute function public.shadow_studio_youtube_status_guard();

revoke all on function public.shadow_studio_claim_youtube_health(integer)
  from public, anon, authenticated;
revoke all on function public.shadow_studio_apply_youtube_health(uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.shadow_studio_youtube_unavailable_to_trash(integer)
  from public, anon, authenticated;

grant execute on function public.shadow_studio_claim_youtube_health(integer) to service_role;
grant execute on function public.shadow_studio_apply_youtube_health(uuid, timestamptz, text) to service_role;
grant execute on function public.shadow_studio_youtube_unavailable_to_trash(integer) to service_role;

select cron.schedule(
  'shadow-studio-youtube-unavailable-to-trash-30d',
  '0 3 * * *',
  'select public.shadow_studio_youtube_unavailable_to_trash(200)'
);
