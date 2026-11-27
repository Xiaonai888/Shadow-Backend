begin;
create table if not exists public.shadow_ai_booking_drafts (
  reader_user_id uuid not null,
  author_page_id uuid not null references public.author_pages(id) on delete cascade,
  campaign_id uuid not null references public.author_preorder_campaigns(id) on delete cascade,
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 16000),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (reader_user_id, author_page_id, campaign_id),
  check (expires_at > updated_at)
);
create index if not exists shadow_ai_booking_drafts_expiry_idx on public.shadow_ai_booking_drafts (expires_at);
alter table public.shadow_ai_booking_drafts enable row level security;
revoke all on table public.shadow_ai_booking_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.shadow_ai_booking_drafts to service_role;
commit;
