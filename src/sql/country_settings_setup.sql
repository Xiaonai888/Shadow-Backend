begin;

create table if not exists public.shadow_country_settings (
  settings_key text primary key default 'default'
    check (settings_key = 'default'),
  rules jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  check (
    jsonb_typeof(rules) = 'object'
    and jsonb_typeof(rules -> 'kh') = 'object'
    and jsonb_typeof(rules -> 'international') = 'object'
  )
);

insert into public.shadow_country_settings (settings_key, rules)
values (
  'default',
  '{
    "kh": {
      "app": true,
      "physicalBooks": true,
      "binancePay": false,
      "payway": true,
      "storyLanguage": "km",
      "shopTarget": "shadow_mall"
    },
    "international": {
      "app": false,
      "physicalBooks": false,
      "binancePay": true,
      "payway": false,
      "storyLanguage": "en",
      "shopTarget": "diamonds"
    }
  }'::jsonb
)
on conflict (settings_key) do nothing;

create table if not exists public.shadow_country_user_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  mode text not null check (mode in ('cambodia_experience', 'all_eligible', 'custom')),
  overrides jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(overrides) = 'object')
);

create index if not exists shadow_country_user_exceptions_updated_idx
  on public.shadow_country_user_exceptions (updated_at desc, id);

alter table public.shadow_country_settings enable row level security;
alter table public.shadow_country_user_exceptions enable row level security;

revoke all on public.shadow_country_settings from public, anon, authenticated;
revoke all on public.shadow_country_user_exceptions from public, anon, authenticated;

grant select, insert, update, delete on public.shadow_country_settings to service_role;
grant select, insert, update, delete on public.shadow_country_user_exceptions to service_role;

commit;
