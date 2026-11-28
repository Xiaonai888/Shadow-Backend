begin;

create or replace function public.author_auto_post_get_settings_v1(p_user_id text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare a uuid; s public.author_auto_post_settings%rowtype; sys public.author_auto_post_system%rowtype; w public.author_auto_post_weekly_usage%rowtype; c public.author_auto_post_credit_balances%rowtype; week_key date;
begin
  select id into a from public.author_pages where user_id::text=p_user_id and status='active';
  if a is null then return jsonb_build_object('state','not_found'); end if;
  select * into s from public.author_auto_post_settings where author_id=a;
  select * into sys from public.author_auto_post_system where id=true;
  week_key:=date_trunc('week',now() at time zone 'Asia/Phnom_Penh')::date;
  select * into w from public.author_auto_post_weekly_usage where author_id=a and week_start=week_key;
  select * into c from public.author_auto_post_credit_balances where author_id=a;
  return jsonb_build_object('state','ok','author_id',a,'settings',jsonb_build_object(
    'enabled',coalesce(s.enabled,false),'header_text',coalesce(s.header_text,''),'footer_text',coalesce(s.footer_text,''),
    'content_percent',coalesce(s.content_percent,30),'episode_filter',coalesce(s.episode_filter,'all'),
    'selection_mode',coalesce(s.selection_mode,'all'),'story_ids',coalesce(s.story_ids,'{}'::uuid[]),
    'posting_mode',coalesce(s.posting_mode,'update'),'include_cover',coalesce(s.include_cover,true),
    'locked_content_confirmed',coalesce(s.locked_content_confirmed,false),'updated_at',s.updated_at,
    'suspended',s.suspended_at is not null and (s.suspended_until is null or s.suspended_until>now()),'suspended_until',s.suspended_until,'suspension_reason',s.suspension_reason),
    'system',jsonb_build_object('enabled',sys.enabled,'weekly_free_posts',sys.weekly_free_posts,'package_credits',sys.package_credits,'package_diamonds',sys.package_diamonds,'enabled_platforms',sys.enabled_platforms),
    'credits',jsonb_build_object('week_start',week_key,'reset_at',((week_key+7)::timestamp at time zone 'Asia/Phnom_Penh'),
    'weekly_used',coalesce(w.used,0),'weekly_reserved',coalesce(w.reserved,0),'weekly_remaining',greatest(0,sys.weekly_free_posts-coalesce(w.used,0)-coalesce(w.reserved,0)),
    'purchased_available',coalesce(c.available,0),'purchased_reserved',coalesce(c.reserved,0)));
end;
$$;

create or replace function public.author_auto_post_save_settings_v1(p_user_id text,p_settings jsonb,p_expected_revision timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a uuid; s public.author_auto_post_settings%rowtype; ids uuid[]; pct integer; mode text; filter_value text; post_mode text; header_value text; footer_value text; on_value boolean; cover_value boolean; confirmed boolean;
begin
  if p_settings is null or jsonb_typeof(p_settings)<>'object' or not (p_settings ?& array['enabled','header_text','footer_text','content_percent','episode_filter','selection_mode','story_ids','posting_mode','include_cover','locked_content_confirmed']) then return jsonb_build_object('state','invalid'); end if;
  if jsonb_typeof(p_settings->'enabled') is distinct from 'boolean' or jsonb_typeof(p_settings->'include_cover') is distinct from 'boolean' or jsonb_typeof(p_settings->'locked_content_confirmed') is distinct from 'boolean' or jsonb_typeof(p_settings->'header_text') is distinct from 'string' or jsonb_typeof(p_settings->'footer_text') is distinct from 'string' or jsonb_typeof(p_settings->'content_percent') is distinct from 'number' or jsonb_typeof(p_settings->'story_ids') is distinct from 'array' then return jsonb_build_object('state','invalid'); end if;
  if (p_settings->>'content_percent') !~ '^(10|20|30|40|50|60|70|80|90|100)$' or jsonb_array_length(p_settings->'story_ids')>1000 then return jsonb_build_object('state','invalid'); end if;
  if exists(select 1 from jsonb_array_elements(p_settings->'story_ids') x where jsonb_typeof(x)<>'string' or (x#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return jsonb_build_object('state','invalid'); end if;
  select coalesce(array_agg(distinct (x#>>'{}')::uuid),'{}'::uuid[]) into ids from jsonb_array_elements(p_settings->'story_ids') x;
  pct:=(p_settings->>'content_percent')::integer; mode:=p_settings->>'selection_mode'; filter_value:=p_settings->>'episode_filter'; post_mode:=p_settings->>'posting_mode';
  header_value:=p_settings->>'header_text'; footer_value:=p_settings->>'footer_text'; on_value:=(p_settings->>'enabled')::boolean; cover_value:=(p_settings->>'include_cover')::boolean; confirmed:=(p_settings->>'locked_content_confirmed')::boolean;
  if mode is null or mode not in ('all','selected') or filter_value is null or filter_value not in ('all','locked','free') or post_mode is null or post_mode not in ('update','promotion','both') or char_length(header_value)>300 or char_length(footer_value)>300 or (mode='selected' and cardinality(ids)=0) or (mode='all' and cardinality(ids)>0) then return jsonb_build_object('state','invalid'); end if;
  if pct>30 and filter_value<>'free' and not confirmed then return jsonb_build_object('state','confirmation_required'); end if;
  select id into a from public.author_pages where user_id::text=p_user_id and status='active';
  if a is null then return jsonb_build_object('state','not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('author_auto_post:'||a::text,0));
  if exists(select 1 from unnest(ids) i where not exists(select 1 from public.stories st where st.id=i and st.author_id=a and st.deleted_at is null)) then return jsonb_build_object('state','invalid_story'); end if;
  select * into s from public.author_auto_post_settings where author_id=a for update;
  if found then
    if s.updated_at is distinct from p_expected_revision then return jsonb_build_object('state','stale_settings'); end if;
    if on_value and s.suspended_at is not null and (s.suspended_until is null or s.suspended_until>now()) then return jsonb_build_object('state','suspended'); end if;
  elsif p_expected_revision is not null then return jsonb_build_object('state','stale_settings'); end if;
  insert into public.author_auto_post_settings(author_id,enabled,header_text,footer_text,content_percent,episode_filter,selection_mode,story_ids,posting_mode,include_cover,locked_content_confirmed,updated_at)
  values(a,on_value,header_value,footer_value,pct,filter_value,mode,ids,post_mode,cover_value,confirmed,clock_timestamp())
  on conflict(author_id) do update set enabled=excluded.enabled,header_text=excluded.header_text,footer_text=excluded.footer_text,content_percent=excluded.content_percent,episode_filter=excluded.episode_filter,selection_mode=excluded.selection_mode,story_ids=excluded.story_ids,posting_mode=excluded.posting_mode,include_cover=excluded.include_cover,locked_content_confirmed=excluded.locked_content_confirmed,updated_at=excluded.updated_at
  returning * into s;
  return jsonb_build_object('state','ok','updated_at',s.updated_at);
end;
$$;

revoke all on function public.author_auto_post_get_settings_v1(text),public.author_auto_post_save_settings_v1(text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.author_auto_post_get_settings_v1(text),public.author_auto_post_save_settings_v1(text,jsonb,timestamptz) to service_role;
commit;
