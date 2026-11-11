create extension if not exists pg_cron with schema pg_catalog;

alter table public.fast_videos
  add column if not exists studio_state text not null default 'active',
  add column if not exists studio_restore_status text,
  add column if not exists studio_trashed_from text,
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fast_videos'::regclass
      and conname = 'fast_videos_studio_state_check'
  ) then
    alter table public.fast_videos
      add constraint fast_videos_studio_state_check
      check (
        (studio_state = 'active' and archived_at is null and deleted_at is null and purge_at is null and studio_restore_status is null and studio_trashed_from is null)
        or (studio_state = 'archived' and archived_at is not null and deleted_at is null and purge_at is null and studio_restore_status in ('draft', 'published') and studio_trashed_from is null and status = 'draft')
        or (studio_state = 'trashed' and deleted_at is not null and purge_at > deleted_at and studio_restore_status in ('draft', 'published') and studio_trashed_from in ('active', 'archived') and status = 'draft')
      );
  end if;
end;
$$;

create index if not exists fast_videos_studio_owner_state_idx
  on public.fast_videos (user_id, studio_state, published_at desc, id desc);

create index if not exists fast_videos_studio_owner_kind_idx
  on public.fast_videos (user_id, studio_state, video_type);

create index if not exists fast_videos_studio_archive_idx
  on public.fast_videos (user_id, archived_at desc, id desc)
  where studio_state = 'archived';

create index if not exists fast_videos_studio_trash_idx
  on public.fast_videos (user_id, deleted_at desc, id desc)
  where studio_state = 'trashed';

create index if not exists fast_videos_studio_purge_idx
  on public.fast_videos (purge_at, id)
  where studio_state = 'trashed';

create or replace function public.shadow_studio_me_summary(p_owner uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total', count(*),
    'long', count(*) filter (where video_type is distinct from 'short'),
    'short', count(*) filter (where video_type = 'short')
  )
  from public.fast_videos
  where user_id = p_owner and studio_state = 'active';
$$;

create or replace function public.shadow_studio_recycle_video(
  p_owner uuid,
  p_video uuid,
  p_action text
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
  if p_action not in ('archive', 'unarchive', 'trash', 'restore', 'purge') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ACTION');
  end if;

  select * into v_video
  from public.fast_videos
  where id = p_video and user_id = p_owner
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  if p_action = 'archive' then
    if v_video.studio_state <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    update public.fast_videos
    set studio_state = 'archived', studio_restore_status = v_video.status,
        archived_at = v_now, status = 'draft'
    where id = p_video and user_id = p_owner;
    return jsonb_build_object('ok', true, 'id', p_video, 'state', 'archived');
  end if;

  if p_action = 'unarchive' then
    if v_video.studio_state <> 'archived' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    update public.fast_videos
    set studio_state = 'active', status = v_video.studio_restore_status,
        studio_restore_status = null, archived_at = null
    where id = p_video and user_id = p_owner;
    return jsonb_build_object('ok', true, 'id', p_video, 'state', 'active');
  end if;

  if p_action = 'trash' then
    if v_video.studio_state = 'trashed' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    update public.fast_videos
    set studio_state = 'trashed',
        studio_restore_status = coalesce(v_video.studio_restore_status, v_video.status),
        studio_trashed_from = v_video.studio_state,
        deleted_at = v_now, purge_at = v_now + interval '30 days',
        status = 'draft'
    where id = p_video and user_id = p_owner;
    return jsonb_build_object('ok', true, 'id', p_video, 'state', 'trashed');
  end if;

  if p_action = 'restore' then
    if v_video.studio_state <> 'trashed' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    if v_video.purge_at <= v_now then
      return jsonb_build_object('ok', false, 'code', 'EXPIRED');
    end if;
    if v_video.studio_trashed_from = 'archived' then
      update public.fast_videos
      set studio_state = 'archived', studio_trashed_from = null,
          deleted_at = null, purge_at = null, status = 'draft'
      where id = p_video and user_id = p_owner;
      return jsonb_build_object('ok', true, 'id', p_video, 'state', 'archived');
    end if;
    update public.fast_videos
    set studio_state = 'active', status = v_video.studio_restore_status,
        studio_restore_status = null, studio_trashed_from = null,
        archived_at = null, deleted_at = null, purge_at = null
    where id = p_video and user_id = p_owner;
    return jsonb_build_object('ok', true, 'id', p_video, 'state', 'active');
  end if;

  if v_video.studio_state <> 'trashed' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  end if;

  delete from public.fast_videos
  where id = p_video and user_id = p_owner;
  return jsonb_build_object('ok', true, 'id', p_video, 'state', 'purged');
end;
$$;

create or replace function public.purge_shadow_studio_trash(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer := 0;
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'Invalid purge batch size';
  end if;

  with expired as (
    select id
    from public.fast_videos
    where studio_state = 'trashed'
      and purge_at <= clock_timestamp()
    order by purge_at, id
    for update skip locked
    limit p_limit
  ), removed as (
    delete from public.fast_videos
    where id in (select id from expired)
    returning id
  )
  select count(*) into v_deleted from removed;

  return v_deleted;
end;
$$;

revoke all on function public.shadow_studio_me_summary(uuid)
  from public, anon, authenticated;
revoke all on function public.shadow_studio_recycle_video(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.purge_shadow_studio_trash(integer)
  from public, anon, authenticated;

grant execute on function public.shadow_studio_me_summary(uuid)
  to service_role;
grant execute on function public.shadow_studio_recycle_video(uuid, uuid, text)
  to service_role;
grant execute on function public.purge_shadow_studio_trash(integer)
  to service_role;

select cron.schedule(
  'shadow-studio-reel-trash-purge-30d',
  '15 * * * *',
  'select public.purge_shadow_studio_trash(200)'
);
