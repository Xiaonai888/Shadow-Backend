begin;

alter table public.social_media_connections
  drop constraint if exists social_media_connections_platform_check;
alter table public.social_media_connections
  add constraint social_media_connections_platform_check check (platform in ('facebook','instagram'));

alter table public.social_promotion_rules
  add column if not exists language text not null default 'km',
  add column if not exists source_topic text not null default 'solo',
  add column if not exists story_types text[] not null default '{}';

do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid='public.social_promotion_rules'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%selection_mode%'
  loop
    execute format('alter table public.social_promotion_rules drop constraint %I',c.conname);
  end loop;
end;
$$;

alter table public.social_promotion_rules
  add constraint social_promotion_rules_selection_v2 check (
    selection_mode in ('smart','stories','authors','mixed')
    and (not enabled or (cardinality(publish_times)>0 and (
      (selection_mode='smart' and cardinality(story_ids)=0 and cardinality(author_ids)=0)
      or (selection_mode='stories' and cardinality(story_ids)>0 and cardinality(author_ids)=0)
      or (selection_mode='authors' and cardinality(author_ids)>0 and cardinality(story_ids)=0)
      or (selection_mode='mixed' and cardinality(story_ids)+cardinality(author_ids)>0)
    )))
  );

alter table public.social_promotion_rules
  add constraint social_promotion_rules_language_v2 check (language in ('km','en','zh','ja','ko')),
  add constraint social_promotion_rules_topic_v2 check (source_topic in ('solo','update','gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','night')),
  add constraint social_promotion_rules_types_v2 check (cardinality(story_types)<=3 and array_position(story_types,null) is null and story_types <@ array['novel','manga','chat_story']::text[]),
  add constraint social_promotion_rules_admin_short_v2 check (content_mode='short');

create or replace function public.social_promotion_touch_rule_v2()
returns trigger language plpgsql set search_path='' as $$
begin
  new.updated_at=clock_timestamp();
  return new;
end;
$$;
revoke all on function public.social_promotion_touch_rule_v2() from public,anon,authenticated;
drop trigger if exists social_promotion_touch_rule_v2 on public.social_promotion_rules;
create trigger social_promotion_touch_rule_v2 before update on public.social_promotion_rules
for each row execute function public.social_promotion_touch_rule_v2();

alter table public.social_media_jobs
  add column if not exists language text,
  add column if not exists post_kind text,
  add column if not exists source_topic text,
  add column if not exists caption_id text,
  add column if not exists rule_revision timestamptz;

alter table public.social_media_jobs
  add constraint social_media_jobs_admin_short_v2 check (owner_type<>'admin' or content_mode='short'),
  add constraint social_media_jobs_metadata_v2 check (
    rule_revision is null or (
      owner_type='admin' and rule_id is not null and language is not null and language in ('km','en','zh','ja','ko')
      and post_kind is not null and post_kind in ('solo','group','update')
      and source_topic is not null and source_topic in ('solo','update','gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','night')
      and (post_kind='update')=(source_topic='update')
      and (post_kind<>'group' or source_topic<>'solo')
      and (caption_id is null or char_length(caption_id) between 1 and 160)
    )
  );

alter table public.social_media_jobs drop constraint if exists social_media_jobs_connection_id_episode_id_key;
create unique index if not exists social_media_jobs_legacy_episode_v2_idx on public.social_media_jobs(connection_id,episode_id) where rule_revision is null;
create unique index if not exists social_media_jobs_rule_slot_v2_idx on public.social_media_jobs(rule_id,scheduled_at) where rule_revision is not null;
create index if not exists social_media_jobs_connection_history_v2_idx on public.social_media_jobs(connection_id,language,status,finished_at);
create index if not exists social_media_jobs_rule_day_v2_idx on public.social_media_jobs(rule_id,scheduled_at);

create table if not exists public.social_media_job_items (
  job_id uuid not null references public.social_media_jobs(id) on delete cascade,
  position smallint not null check (position between 1 and 5),
  story_id uuid not null,
  episode_id uuid not null,
  primary key(job_id,position),
  unique(job_id,story_id),
  unique(job_id,episode_id)
);
create index if not exists social_media_job_items_story_v2_idx on public.social_media_job_items(story_id,job_id);
create index if not exists social_media_job_items_episode_v2_idx on public.social_media_job_items(episode_id,job_id);
alter table public.social_media_job_items enable row level security;
revoke all on public.social_media_job_items from public,anon,authenticated;
grant select,insert,update,delete on public.social_media_job_items to service_role;

commit;
