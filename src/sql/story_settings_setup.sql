alter table public.stories
add column if not exists story_settings text[] not null default '{}'::text[];

alter table public.stories
drop constraint if exists stories_story_settings_max_6_check;

alter table public.stories
add constraint stories_story_settings_max_6_check
check (cardinality(story_settings) <= 6);

create index if not exists stories_story_settings_gin_idx
on public.stories
using gin (story_settings);
