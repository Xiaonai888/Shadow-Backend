alter table public.author_pages
  add column if not exists ranking_visibility_status text not null default 'visible',
  add column if not exists ranking_hidden_reason text not null default '',
  add column if not exists ranking_hidden_at timestamptz,
  add column if not exists ranking_hidden_by text not null default '',
  add column if not exists ranking_note text not null default '';

update public.author_pages
set ranking_visibility_status = 'visible'
where ranking_visibility_status is null
   or ranking_visibility_status not in ('visible', 'hidden');

alter table public.episodes
  add column if not exists ranking_visibility_status text not null default 'visible',
  add column if not exists ranking_hidden_reason text not null default '',
  add column if not exists ranking_hidden_at timestamptz,
  add column if not exists ranking_hidden_by text not null default '',
  add column if not exists ranking_note text not null default '';

update public.episodes
set ranking_visibility_status = 'visible'
where ranking_visibility_status is null
   or ranking_visibility_status not in ('visible', 'hidden');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'author_pages_ranking_visibility_status_check'
      and conrelid = 'public.author_pages'::regclass
  ) then
    alter table public.author_pages
      add constraint author_pages_ranking_visibility_status_check
      check (ranking_visibility_status in ('visible', 'hidden'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'episodes_ranking_visibility_status_check'
      and conrelid = 'public.episodes'::regclass
  ) then
    alter table public.episodes
      add constraint episodes_ranking_visibility_status_check
      check (ranking_visibility_status in ('visible', 'hidden'));
  end if;
end
$$;

create index if not exists author_pages_ranking_visibility_status_idx
  on public.author_pages (ranking_visibility_status);

create index if not exists episodes_ranking_visibility_status_idx
  on public.episodes (ranking_visibility_status);

create index if not exists episodes_story_ranking_visibility_idx
  on public.episodes (story_id, ranking_visibility_status);
