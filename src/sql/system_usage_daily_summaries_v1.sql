create table if not exists public.system_usage_daily_summaries (
  summary_date date not null,
  source_kind text not null check (source_kind ~ '^[a-z0-9_:-]{1,80}$'),
  archive_set_sha256 text not null check (archive_set_sha256 ~ '^[0-9a-f]{64}$'),
  summary_sha256 text not null check (summary_sha256 ~ '^[0-9a-f]{64}$'),
  archive_keys jsonb not null check (jsonb_typeof(archive_keys) = 'array'),
  source_rows bigint not null check (source_rows >= 0),
  group_count bigint not null check (group_count >= 0),
  totals jsonb not null,
  breakdown jsonb not null check (jsonb_typeof(breakdown) = 'array'),
  coverage jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (summary_date, source_kind)
);

create index if not exists system_usage_daily_summaries_kind_day_idx
  on public.system_usage_daily_summaries (source_kind, summary_date desc);

alter table public.system_usage_daily_summaries enable row level security;
revoke all on public.system_usage_daily_summaries from anon, authenticated;

create or replace function public.save_system_usage_daily_summary(p_summary jsonb)
returns setof public.system_usage_daily_summaries
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_summary is null or jsonb_typeof(p_summary) <> 'object' then
    raise exception 'Invalid daily usage summary payload';
  end if;

  return query
  insert into public.system_usage_daily_summaries as existing (
    summary_date, source_kind, archive_set_sha256, summary_sha256, archive_keys,
    source_rows, group_count, totals, breakdown, coverage
  ) values (
    (p_summary->>'summary_date')::date,
    p_summary->>'source_kind',
    p_summary->>'archive_set_sha256',
    p_summary->>'summary_sha256',
    p_summary->'archive_keys',
    (p_summary->>'source_rows')::bigint,
    (p_summary->>'group_count')::bigint,
    p_summary->'totals',
    p_summary->'breakdown',
    p_summary->'coverage'
  )
  on conflict (summary_date, source_kind)
  do update set
    archive_set_sha256 = excluded.archive_set_sha256,
    summary_sha256 = excluded.summary_sha256,
    archive_keys = excluded.archive_keys,
    source_rows = excluded.source_rows,
    group_count = excluded.group_count,
    totals = excluded.totals,
    breakdown = excluded.breakdown,
    coverage = excluded.coverage,
    updated_at = now()
  where existing.archive_keys <@ excluded.archive_keys
    and (
      existing.archive_set_sha256 <> excluded.archive_set_sha256
      or existing.summary_sha256 = excluded.summary_sha256
    )
  returning *;
end;
$$;

revoke all on function public.save_system_usage_daily_summary(jsonb)
  from public, anon, authenticated;
grant execute on function public.save_system_usage_daily_summary(jsonb)
  to service_role;
