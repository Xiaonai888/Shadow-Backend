begin;

create table if not exists public.telegram_promotion_events (
  language text not null references public.telegram_promotion_settings(language),
  episode_id uuid not null,
  story_id uuid not null,
  first_published_at timestamptz not null,
  due_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending','queued','skipped')),
  attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key(language,episode_id)
);
create index if not exists telegram_promotion_events_due_idx on public.telegram_promotion_events(language,due_at,first_published_at,episode_id) where state='pending';
alter table public.telegram_promotion_events enable row level security;
revoke all on public.telegram_promotion_events from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_events to service_role;

create or replace function public.telegram_promotion_language_v1(p_value text)
returns text language sql immutable security invoker set search_path='' as $$
 select case lower(trim(p_value)) when 'khmer' then 'km' when 'kh' then 'km' when 'km' then 'km' when 'english' then 'en' when 'en' then 'en' when 'chinese' then 'zh' when 'zh' then 'zh' when 'korean' then 'ko' when 'ko' then 'ko' when 'kr' then 'ko' when 'japanese' then 'ja' when 'ja' then 'ja' when 'jp' then 'ja' end;
$$;

create or replace function public.telegram_promotion_capture_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_language text;
begin
  if new.status <> 'published' or new.first_published_at is null or new.deleted_at is not null then return new; end if;
  if tg_op='UPDATE' then
    if old.first_published_at is not null and old.status <> 'scheduled' then return new; end if;
  end if;
  select public.telegram_promotion_language_v1(s.story_language) into v_language from public.stories s where s.id=new.story_id;
  if not exists(select 1 from public.telegram_promotion_settings s where s.language=v_language and s.enabled and new.first_published_at >= (date_trunc('day',s.enabled_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh')) then return new; end if;
  insert into public.telegram_promotion_events(language,episode_id,story_id,first_published_at,due_at)
  values(v_language,new.id,new.story_id,new.first_published_at,greatest(new.first_published_at,new.published_at,new.scheduled_at,now()))
  on conflict(language,episode_id) do nothing;
  return new;
exception when others then
  raise warning 'TELEGRAM_PROMOTION_CAPTURE_FAILED: %',sqlstate;
  return new;
end;
$$;

drop trigger if exists telegram_promotion_capture_episode on public.episodes;
create trigger telegram_promotion_capture_episode after insert or update of status,first_published_at,published_at,scheduled_at on public.episodes for each row execute function public.telegram_promotion_capture_v1();

create or replace function public.telegram_promotion_reconcile_v1(p_language text,p_from timestamptz,p_to timestamptz,p_after_at timestamptz default null,p_after_id uuid default null,p_limit integer default 100)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_rows jsonb; v_added integer; v_from timestamptz;
begin
  select greatest(p_from,date_trunc('day',s.enabled_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh') into v_from from public.telegram_promotion_settings s where s.language=p_language and s.enabled;
  if not found then return jsonb_build_object('rows','[]'::jsonb,'added',0); end if;
  if p_from is null or p_to is null or p_to<=p_from or (p_after_at is null) <> (p_after_id is null) then raise exception 'Invalid reconciliation window'; end if;
  with candidates as materialized (
    select e.id,e.story_id,e.first_published_at,greatest(e.first_published_at,e.published_at,e.scheduled_at) as due_at
    from public.episodes e join public.stories s on s.id=e.story_id
    where e.status='published' and e.deleted_at is null and e.first_published_at>=v_from and e.first_published_at<p_to
      and public.telegram_promotion_language_v1(s.story_language)=p_language
      and (p_after_at is null or (e.first_published_at,e.id)>(p_after_at,p_after_id))
    order by e.first_published_at,e.id limit greatest(1,least(100,coalesce(p_limit,100)))
  ), inserted as (
    insert into public.telegram_promotion_events(language,episode_id,story_id,first_published_at,due_at)
    select p_language,c.id,c.story_id,c.first_published_at,c.due_at from candidates c
    on conflict(language,episode_id) do nothing returning episode_id
  )
  select coalesce((select jsonb_agg(jsonb_build_object('episode_id',id,'first_published_at',first_published_at) order by first_published_at,id) from candidates),'[]'::jsonb),(select count(*) from inserted) into v_rows,v_added;
  return jsonb_build_object('rows',v_rows,'added',v_added);
end;
$$;

revoke all on function public.telegram_promotion_capture_v1(),public.telegram_promotion_language_v1(text),public.telegram_promotion_reconcile_v1(text,timestamptz,timestamptz,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.telegram_promotion_language_v1(text),public.telegram_promotion_reconcile_v1(text,timestamptz,timestamptz,timestamptz,uuid,integer) to service_role;
commit;
