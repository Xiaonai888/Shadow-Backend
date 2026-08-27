create table if not exists public.ranking_settings (
  id integer primary key default 1 check (id = 1),

  story_view_weight numeric(12,4) not null default 1,
  story_like_weight numeric(12,4) not null default 5,
  story_comment_weight numeric(12,4) not null default 10,
  story_episode_weight numeric(12,4) not null default 3,

  author_view_weight numeric(12,4) not null default 1,
  author_like_weight numeric(12,4) not null default 5,
  author_comment_weight numeric(12,4) not null default 10,
  author_follower_weight numeric(12,4) not null default 20,
  author_story_weight numeric(12,4) not null default 3,

  episode_view_weight numeric(12,4) not null default 1,
  episode_like_weight numeric(12,4) not null default 5,
  episode_comment_weight numeric(12,4) not null default 10,

  min_story_views bigint not null default 0,
  min_story_likes bigint not null default 0,
  min_story_comments bigint not null default 0,
  min_story_episodes bigint not null default 0,

  min_author_stories bigint not null default 1,
  min_author_followers bigint not null default 0,

  min_episode_views bigint not null default 0,
  min_episode_likes bigint not null default 0,
  min_episode_comments bigint not null default 0,

  story_rank_enabled boolean not null default true,
  genre_rank_enabled boolean not null default true,
  author_rank_enabled boolean not null default true,
  episode_rank_enabled boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

insert into public.ranking_settings (id)
values (1)
on conflict (id) do nothing;
