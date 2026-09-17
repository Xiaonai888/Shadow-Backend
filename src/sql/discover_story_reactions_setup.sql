create table if not exists public.discover_story_reactions (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  story_id text not null,
  user_id uuid not null
    references public.users(id)
    on delete cascade,
  reaction_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discover_story_reactions_source_check
    check (
      source_type in (
        'reader',
        'author'
      )
    ),
  constraint discover_story_reactions_type_check
    check (
      reaction_type in (
        'love',
        'haha',
        'wow',
        'sad',
        'angry',
        'support',
        'touched'
      )
    ),
  constraint discover_story_reactions_unique
    unique (
      source_type,
      story_id,
      user_id
    )
);

create index if not exists
discover_story_reactions_story_idx
on public.discover_story_reactions (
  source_type,
  story_id,
  reaction_type
);

create index if not exists
discover_story_reactions_user_idx
on public.discover_story_reactions (
  user_id,
  created_at desc
);

create or replace function
public.touch_discover_story_reaction_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists
touch_discover_story_reaction_updated_at_trigger
on public.discover_story_reactions;

create trigger
touch_discover_story_reaction_updated_at_trigger
before update
on public.discover_story_reactions
for each row
execute function
public.touch_discover_story_reaction_updated_at();

create or replace function
public.cleanup_reader_story_reactions()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.discover_story_reactions
    where source_type = 'reader'
      and story_id = old.id::text;
    return old;
  end if;

  if new.status <> 'active' then
    delete from public.discover_story_reactions
    where source_type = 'reader'
      and story_id = new.id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists
cleanup_reader_story_reactions_trigger
on public.reader_stories;

create trigger
cleanup_reader_story_reactions_trigger
after delete or update of status
on public.reader_stories
for each row
execute function
public.cleanup_reader_story_reactions();

create or replace function
public.cleanup_author_story_reactions()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.discover_story_reactions
    where source_type = 'author'
      and story_id = old.id::text;
    return old;
  end if;

  if new.status <> 'active' then
    delete from public.discover_story_reactions
    where source_type = 'author'
      and story_id = new.id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists
cleanup_author_story_reactions_trigger
on public.author_page_stories;

create trigger
cleanup_author_story_reactions_trigger
after delete or update of status
on public.author_page_stories
for each row
execute function
public.cleanup_author_story_reactions();

alter table public.discover_story_reactions
enable row level security;

revoke all
on public.discover_story_reactions
from public, anon, authenticated;

grant all
on public.discover_story_reactions
to service_role;
