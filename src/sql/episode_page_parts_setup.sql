create table if not exists public.episode_page_parts (
  id uuid primary key default gen_random_uuid(),
  episode_page_id uuid not null references public.episode_pages(id) on delete cascade,
  part_index integer not null check (part_index >= 0),
  image_url text not null,
  storage_path text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  file_size bigint check (file_size is null or file_size > 0),
  mime_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (episode_page_id, part_index)
);

create index if not exists episode_page_parts_page_order_idx
  on public.episode_page_parts (episode_page_id, part_index);

alter table public.episode_page_parts enable row level security;
