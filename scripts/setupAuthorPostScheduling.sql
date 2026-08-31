alter table public.author_page_posts
  add column if not exists scheduled_at timestamptz,
  add column if not exists published_at timestamptz;

update public.author_page_posts
set published_at = created_at
where status = 'active'
  and published_at is null;

create index if not exists author_page_posts_scheduled_due_idx
  on public.author_page_posts (scheduled_at)
  where status = 'scheduled'
    and scheduled_at is not null;

create index if not exists author_page_posts_active_published_idx
  on public.author_page_posts (author_page_id, published_at desc)
  where status = 'active';
