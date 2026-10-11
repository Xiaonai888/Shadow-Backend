create table if not exists public.author_loyalty_reminder_log (
  author_id uuid not null references public.author_pages(id) on delete cascade,
  started_at timestamptz not null,
  reminder_key text not null,
  sent_at timestamptz not null default now(),
  primary key (author_id, started_at, reminder_key),
  constraint author_loyalty_reminder_key_check
    check (reminder_key in ('one_year', 'three_months', 'one_month'))
);

create index if not exists author_loyalty_reward_ends_idx
  on public.author_loyalty_reward_progress(ends_at);

alter table public.author_loyalty_reminder_log enable row level security;

revoke all on public.author_loyalty_reminder_log from public, anon, authenticated;
grant select, insert on public.author_loyalty_reminder_log to service_role;

create or replace function public.send_author_loyalty_reminders(p_limit integer default 1500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_sent integer := 0;
begin
  with candidates as (
    select
      r.author_id,
      r.user_id,
      r.started_at,
      r.ends_at,
      milestone.reminder_key
    from public.author_loyalty_reward_progress r
    left join public.author_quest_progress q on q.author_id = r.author_id
    cross join lateral (
      select case
        when v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '1 month')::date
          then 'one_month'
        when v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '3 months')::date
          then 'three_months'
        else 'one_year'
      end as reminder_key
    ) milestone
    where r.started_at <= now()
      and v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '1 year')::date
      and v_today < (r.ends_at at time zone 'Asia/Phnom_Penh')::date
      and coalesce(q.current_share_percent, 10) < 50
      and not exists (
        select 1
        from public.author_loyalty_reminder_log l
        where l.author_id = r.author_id
          and l.started_at = r.started_at
          and l.reminder_key = milestone.reminder_key
      )
    order by r.ends_at, r.author_id
    limit greatest(1, least(coalesce(p_limit, 1500), 2000))
  ),
  claimed as (
    insert into public.author_loyalty_reminder_log (author_id, started_at, reminder_key)
    select author_id, started_at, reminder_key
    from candidates
    on conflict (author_id, started_at, reminder_key) do nothing
    returning author_id, started_at, reminder_key
  ),
  sent as (
    insert into public.reader_mails (
      user_id,
      sender_type,
      mail_type,
      title,
      message,
      detail,
      action_type,
      reward_type,
      reward_amount,
      link,
      image_url,
      reference_id,
      is_read
    )
    select
      r.user_id,
      'system',
      'system',
      'Author Loyalty Reward — ' || case c.reminder_key
        when 'one_year' then '1 Year Left'
        when 'three_months' then '3 Months Left'
        else '1 Month Left'
      end,
      'កម្មវិធី Author Loyalty Reward របស់អ្នកកំពុងខិតជិតផុតកំណត់។ Stage បច្ចុប្បន្ននៅក្រោម 50%។ សូមបំពេញលក្ខខណ្ឌ Stage 5 ដើម្បីរក្សាចំណូល 50% ក្រោយកម្មវិធីចប់។',
      'Your 3-year Author Loyalty Reward ends on ' ||
      to_char(r.ends_at at time zone 'Asia/Phnom_Penh', 'YYYY-MM-DD') ||
      '. Your normal Quest stage is below 50%. Complete Stage 5 before the reward ends to keep a 50% share. Higher active event shares remain unaffected.',
      'open_link',
      '',
      0,
      'https://www.shadowerabook.site/author/quest?from=income',
      '',
      'author_loyalty_reward_' || c.reminder_key,
      false
    from claimed c
    join public.author_loyalty_reward_progress r
      on r.author_id = c.author_id and r.started_at = c.started_at
    returning id
  )
  select count(*)::integer into v_sent from sent;

  return v_sent;
end;
$$;

revoke all on function public.send_author_loyalty_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.send_author_loyalty_reminders(integer)
  to service_role;
