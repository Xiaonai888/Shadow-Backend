alter table public.fast_videos
  add column if not exists youtube_visibility text not null default 'unknown',
  add column if not exists youtube_checked_at timestamptz,
  add column if not exists youtube_unavailable_since timestamptz,
  add column if not exists youtube_unavailable_reason text,
  add column if not exists youtube_probe_failures integer not null default 0,
  add column if not exists youtube_auto_trashed boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fast_videos_youtube_visibility_check' and conrelid = 'public.fast_videos'::regclass) then
    alter table public.fast_videos add constraint fast_videos_youtube_visibility_check check (youtube_visibility in ('unknown', 'available', 'unavailable'));
  end if;
end;
$$;

create index if not exists fast_videos_youtube_check_due_idx
  on public.fast_videos (youtube_checked_at asc nulls first, id)
  where platform = 'youtube' and studio_state = 'active';

create index if not exists fast_videos_youtube_unavailable_idx
  on public.fast_videos (user_id, youtube_unavailable_since desc, id)
  where youtube_visibility = 'unavailable' and studio_state = 'active';

create or replace function public.shadow_reel_set_youtube_availability(
  p_id uuid,
  p_expected_url text,
  p_result text,
  p_source text default 'google',
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.fast_videos%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_result not in ('available', 'unavailable', 'unknown') or p_source not in ('google', 'oembed', 'none') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESULT');
  end if;
  select * into v_video from public.fast_videos where id = p_id for update;
  if not found or v_video.studio_state <> 'active' or v_video.platform <> 'youtube' or v_video.video_url is distinct from p_expected_url then
    return jsonb_build_object('ok', false, 'code', 'STALE_VIDEO');
  end if;
  if p_result = 'available' then
    update public.fast_videos set
      youtube_visibility = 'available', youtube_checked_at = v_now,
      youtube_unavailable_since = null, youtube_unavailable_reason = null,
      youtube_probe_failures = 0
    where id = p_id;
  elsif p_result = 'unknown' then
    update public.fast_videos set youtube_checked_at = v_now where id = p_id;
  elsif p_source = 'oembed' and v_video.youtube_probe_failures < 1 then
    update public.fast_videos set youtube_checked_at = v_now,
      youtube_probe_failures = 1 where id = p_id;
  else
    update public.fast_videos set youtube_visibility = 'unavailable',
      youtube_unavailable_since = coalesce(v_video.youtube_unavailable_since, v_now),
      youtube_unavailable_reason = left(coalesce(p_reason, 'youtube_unavailable'), 80),
      youtube_probe_failures = greatest(v_video.youtube_probe_failures + 1, 2),
      youtube_checked_at = v_now
    where id = p_id;
  end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.shadow_reel_auto_trash_unavailable(
  p_id uuid,
  p_expected_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.fast_videos%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_video from public.fast_videos where id = p_id for update;
  if not found or v_video.studio_state <> 'active' or v_video.youtube_visibility <> 'unavailable'
    or v_video.video_url is distinct from p_expected_url
    or v_video.youtube_unavailable_since is null
    or v_video.youtube_unavailable_since > v_now - interval '30 days'
    or v_video.youtube_checked_at < v_now - interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'NOT_DUE');
  end if;
  update public.fast_videos set
    studio_state = 'trashed',
    studio_restore_status = v_video.status,
    studio_trashed_from = 'active',
    deleted_at = v_now,
    purge_at = v_now + interval '30 days',
    status = 'draft',
    youtube_auto_trashed = true
  where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.shadow_reel_repair_unavailable_link(
  p_owner uuid,
  p_id uuid,
  p_new_url text,
  p_new_thumbnail text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.fast_videos%rowtype;
begin
  select * into v_video from public.fast_videos where id = p_id and user_id = p_owner for update;
  if not found or v_video.studio_state <> 'active' or v_video.youtube_visibility <> 'unavailable' then
    return jsonb_build_object('ok', false, 'code', 'NOT_UNAVAILABLE');
  end if;
  if p_new_url is null or length(p_new_url) > 500 or p_new_thumbnail is null or length(p_new_thumbnail) > 500 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_URL');
  end if;
  update public.fast_videos set
    video_url = p_new_url,
    thumbnail_url = p_new_thumbnail,
    youtube_visibility = 'available',
    youtube_checked_at = clock_timestamp(),
    youtube_unavailable_since = null,
    youtube_unavailable_reason = null,
    youtube_probe_failures = 0,
    youtube_auto_trashed = false
  where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.shadow_studio_me_summary(p_owner uuid)
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total', count(*),
    'long', count(*) filter (where video_type is distinct from 'short'),
    'short', count(*) filter (where video_type = 'short')
  ) from public.fast_videos
  where user_id = p_owner and studio_state = 'active'
    and youtube_visibility <> 'unavailable';
$$;

revoke all on function public.shadow_reel_set_youtube_availability(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.shadow_reel_auto_trash_unavailable(uuid,text) from public, anon, authenticated;
revoke all on function public.shadow_reel_repair_unavailable_link(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.shadow_reel_set_youtube_availability(uuid,text,text,text,text) to service_role;
grant execute on function public.shadow_reel_auto_trash_unavailable(uuid,text) to service_role;
grant execute on function public.shadow_reel_repair_unavailable_link(uuid,uuid,text,text) to service_role;
