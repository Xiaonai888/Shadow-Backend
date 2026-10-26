begin;

create table if not exists public.profile_frame_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (
    char_length(btrim(name)) between 1 and 80
    and name = btrim(name)
    and lower(name) <> 'general'
  ),
  sort_order integer not null default 0 check (sort_order between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profile_frame_folders_name_unique_idx
  on public.profile_frame_folders (lower(name));

create index if not exists profile_frame_folders_order_idx
  on public.profile_frame_folders (sort_order, name, id);

alter table public.profile_frames
  add column if not exists folder_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profile_frames'::regclass
      and conname = 'profile_frames_folder_id_fkey'
  ) then
    alter table public.profile_frames
      add constraint profile_frames_folder_id_fkey
      foreign key (folder_id)
      references public.profile_frame_folders(id)
      on delete set null;
  end if;
end
$$;

create index if not exists profile_frames_folder_admin_idx
  on public.profile_frames (folder_id, sort_order, created_at desc, id);

create index if not exists profile_frames_folder_reader_idx
  on public.profile_frames (folder_id, is_active, sort_order, created_at desc, id);

alter table public.profile_frame_folders enable row level security;
revoke all on public.profile_frame_folders from public, anon, authenticated;
grant select, insert, update, delete on public.profile_frame_folders to service_role;

commit;
