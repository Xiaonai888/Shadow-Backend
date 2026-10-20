begin;

create or replace function public.capture_reader_activity_core()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  activity_user uuid;
  activity_category text;
  activity_action text;
  activity_subject_type text;
  activity_subject_id text;
  activity_key text;
  activity_time timestamptz := clock_timestamp();
  current_day text;
begin
  if tg_table_name = 'story_reactions' then
    if tg_op = 'INSERT' then
      activity_user := new.user_id;
      activity_action := 'like';
      activity_subject_id := new.story_id::text;
    elsif tg_op = 'DELETE' then
      activity_user := old.user_id;
      activity_action := 'unlike';
      activity_subject_id := old.story_id::text;
    else
      return new;
    end if;
    activity_category := 'interactions';
    activity_subject_type := 'story';

  elsif tg_table_name = 'episode_reactions' then
    if tg_op = 'INSERT' then
      activity_user := new.user_id;
      activity_action := 'like';
      activity_subject_id := new.episode_id::text;
    elsif tg_op = 'DELETE' then
      activity_user := old.user_id;
      activity_action := 'unlike';
      activity_subject_id := old.episode_id::text;
    else
      return new;
    end if;
    activity_category := 'interactions';
    activity_subject_type := 'episode';

  elsif tg_table_name = 'saved_posts' then
    if tg_op = 'INSERT' then
      if new.status is distinct from 'active' then return new; end if;
      activity_user := new.user_id;
      activity_action := 'save';
      activity_subject_id := new.id::text;
    elsif tg_op = 'UPDATE' then
      if old.status is not distinct from new.status then return new; end if;
      if new.status = 'active' then
        activity_action := 'save';
      elsif old.status = 'active' then
        activity_action := 'unsave';
      else
        return new;
      end if;
      activity_user := new.user_id;
      activity_subject_id := new.id::text;
    elsif tg_op = 'DELETE' then
      if old.status is distinct from 'active' then return old; end if;
      activity_user := old.user_id;
      activity_action := 'unsave';
      activity_subject_id := old.id::text;
    end if;
    activity_category := 'interactions';
    activity_subject_type := 'saved_post';

  elsif tg_table_name = 'comments' then
    if tg_op = 'INSERT' then
      if new.deleted_at is not null then return new; end if;
      activity_action := 'comment';
      activity_time := coalesce(new.created_at, activity_time);
    elsif tg_op = 'UPDATE' then
      if old.deleted_at is null and new.deleted_at is not null then
        activity_action := 'delete_comment';
      elsif old.deleted_at is null and new.deleted_at is null and old.text is distinct from new.text then
        activity_action := 'edit_comment';
      else
        return new;
      end if;
    else
      return old;
    end if;
    activity_user := new.user_id;
    activity_category := 'interactions';
    activity_subject_type := 'comment';
    activity_subject_id := new.id::text;

  elsif tg_table_name = 'reading_progress' then
    activity_user := new.user_id;
    activity_category := 'reading';
    activity_action := 'read';
    activity_subject_type := 'episode';
    activity_subject_id := new.episode_id::text;
    activity_time := coalesce(new.last_read_at, activity_time);
    if tg_op = 'UPDATE' and new.episode_id is not distinct from old.episode_id
      and (activity_time at time zone 'Asia/Phnom_Penh')::date
        is not distinct from (old.last_read_at at time zone 'Asia/Phnom_Penh')::date then
      return new;
    end if;
    current_day := to_char(activity_time at time zone 'Asia/Phnom_Penh', 'YYYY-MM-DD');
    activity_key := 'read:' || activity_subject_id || ':' || current_day;

  else
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if activity_user is not null and activity_subject_id is not null then
    begin
      insert into public.reader_activity_events (
        user_id, category, action, subject_type, subject_id, event_key, occurred_at
      ) values (
        activity_user, activity_category, activity_action,
        activity_subject_type, left(activity_subject_id, 128), activity_key, activity_time
      ) on conflict do nothing;
    exception when others then
      raise warning 'READER_ACTIVITY_CAPTURE_FAILED: %', sqlerrm;
    end;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.capture_reader_activity_core() from public, anon, authenticated;
grant execute on function public.capture_reader_activity_core() to service_role;

drop trigger if exists reader_activity_story_reactions_trigger on public.story_reactions;
create trigger reader_activity_story_reactions_trigger
after insert or delete on public.story_reactions
for each row execute function public.capture_reader_activity_core();

drop trigger if exists reader_activity_episode_reactions_trigger on public.episode_reactions;
create trigger reader_activity_episode_reactions_trigger
after insert or delete on public.episode_reactions
for each row execute function public.capture_reader_activity_core();

drop trigger if exists reader_activity_saved_posts_trigger on public.saved_posts;
create trigger reader_activity_saved_posts_trigger
after insert or update of status or delete on public.saved_posts
for each row execute function public.capture_reader_activity_core();

drop trigger if exists reader_activity_comments_trigger on public.comments;
create trigger reader_activity_comments_trigger
after insert or update of text, deleted_at on public.comments
for each row execute function public.capture_reader_activity_core();

drop trigger if exists reader_activity_reading_progress_trigger on public.reading_progress;
create trigger reader_activity_reading_progress_trigger
after insert or update of episode_id, last_read_at on public.reading_progress
for each row execute function public.capture_reader_activity_core();

commit;
