alter table public.shadow_events
add column if not exists banner_url text default '',
add column if not exists banner_storage_key text default '';
