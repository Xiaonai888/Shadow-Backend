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
  v_unavailable boolean;
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

  v_unavailable := v_video.platform = 'youtube'
    and v_video.youtube_health_state = 'unavailable';

  if p_action = 'archive' then
    if v_video.studio_state <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    update public.fast_videos
    set studio_state = 'archived',
        studio_restore_status = v_video.status,
        archived_at = v_now,
        status = 'draft'
    where id = p_video and user_id = p_owner;
    return jsonb_build_object('ok', true, 'id', p_video, 'state', 'archived');
  end if;

  if p_action = 'unarchive' then
    if v_video.studio_state <> 'archived' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
    end if;
    update public.fast_videos
    set studio_state = 'active',
        status = case when v_unavailable then 'draft' else v_video.studio_restore_status end,
        studio_restore_status = null,
        archived_at = null,
        youtube_unavailable_since = case when v_unavailable then v_now else v_video.youtube_unavailable_since end,
        youtube_health_checked_at = case when v_unavailable then null else v_video.youtube_health_checked_at end,
        youtube_health_due_at = case when v_unavailable then v_now else v_video.youtube_health_due_at end
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
        deleted_at = v_now,
        purge_at = v_now + interval '30 days',
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
      set studio_state = 'archived',
          studio_trashed_from = null,
          deleted_at = null,
          purge_at = null,
          status = 'draft'
      where id = p_video and user_id = p_owner;
      return jsonb_build_object('ok', true, 'id', p_video, 'state', 'archived');
    end if;
    update public.fast_videos
    set studio_state = 'active',
        status = case when v_unavailable then 'draft' else v_video.studio_restore_status end,
        studio_restore_status = null,
        studio_trashed_from = null,
        archived_at = null,
        deleted_at = null,
        purge_at = null,
        youtube_unavailable_since = case when v_unavailable then v_now else v_video.youtube_unavailable_since end,
        youtube_health_checked_at = case when v_unavailable then null else v_video.youtube_health_checked_at end,
        youtube_health_due_at = case when v_unavailable then v_now else v_video.youtube_health_due_at end
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

revoke all on function public.shadow_studio_recycle_video(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.shadow_studio_recycle_video(uuid, uuid, text)
  to service_role;
