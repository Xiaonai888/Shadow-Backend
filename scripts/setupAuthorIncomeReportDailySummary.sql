begin transaction isolation level repeatable read;

create table if not exists public.author_income_report_daily (
  author_id uuid,
  author_user_id uuid,
  story_id uuid,
  earning_day date,
  currency text not null,
  source_type text not null,
  earning_status text not null,
  transaction_count bigint not null default 0,
  paid_diamonds numeric not null default 0,
  author_earned_diamonds numeric not null default 0,
  author_net_payout_usd numeric not null default 0,
  updated_at timestamptz not null default now(),
  constraint author_income_report_daily_unique unique nulls not distinct (
    author_id, author_user_id, story_id, earning_day, currency, source_type, earning_status
  )
);

create index if not exists idx_author_income_report_daily_author_date
on public.author_income_report_daily (author_id, earning_day desc);

create index if not exists idx_author_income_report_daily_user_date
on public.author_income_report_daily (author_user_id, earning_day desc);

alter table public.author_income_report_daily enable row level security;
revoke all on public.author_income_report_daily from anon, authenticated;
grant select on public.author_income_report_daily to service_role;

insert into public.author_income_report_daily (
  author_id, author_user_id, story_id, earning_day, currency,
  source_type, earning_status, transaction_count, paid_diamonds,
  author_earned_diamonds, author_net_payout_usd, updated_at
)
select
  ae.author_id,
  ae.author_user_id,
  ae.story_id,
  (ae.created_at at time zone 'Asia/Phnom_Penh')::date,
  coalesce(ae.currency, 'unknown'),
  coalesce(ae.source_type, 'unknown'),
  coalesce(ae.earning_status, 'unknown'),
  count(*)::bigint,
  coalesce(sum(ae.paid_diamonds::numeric), 0),
  coalesce(sum(ae.author_earned_diamonds::numeric), 0),
  coalesce(sum(ae.author_net_payout_usd::numeric), 0),
  now()
from public.author_earnings ae
group by
  ae.author_id,
  ae.author_user_id,
  ae.story_id,
  (ae.created_at at time zone 'Asia/Phnom_Penh')::date,
  coalesce(ae.currency, 'unknown'),
  coalesce(ae.source_type, 'unknown'),
  coalesce(ae.earning_status, 'unknown')
on conflict on constraint author_income_report_daily_unique do update set
  transaction_count = excluded.transaction_count,
  paid_diamonds = excluded.paid_diamonds,
  author_earned_diamonds = excluded.author_earned_diamonds,
  author_net_payout_usd = excluded.author_net_payout_usd,
  updated_at = now();

do $verify$
begin
  if (select count(*) from public.author_earnings) <>
     (select coalesce(sum(transaction_count), 0) from public.author_income_report_daily)
  or (select coalesce(sum(author_net_payout_usd::numeric), 0) from public.author_earnings) <>
     (select coalesce(sum(author_net_payout_usd), 0) from public.author_income_report_daily) then
    raise exception 'Author income report summary verification failed';
  end if;
end
$verify$;

commit;

select
  (select count(*) from public.author_earnings) as ledger_records,
  (select coalesce(sum(transaction_count), 0) from public.author_income_report_daily) as summary_records,
  (select coalesce(sum(author_net_payout_usd::numeric), 0) from public.author_earnings) as ledger_usd,
  (select coalesce(sum(author_net_payout_usd), 0) from public.author_income_report_daily) as summary_usd;

