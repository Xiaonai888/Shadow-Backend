-- Run this in Supabase SQL Editor before using the backend.

create table if not exists slides (
  id uuid primary key default gen_random_uuid(),

  section_key text not null default 'home_top_slider',

  title text,
  subtitle text,
  image_url text not null,
  link_url text,

  order_index int not null default 0,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists slides_section_active_order_idx
on slides (section_key, is_active, order_index);

-- Storage bucket:
-- Create a public bucket named: media
-- Supabase Dashboard -> Storage -> New bucket -> Name: media -> Public bucket: ON
