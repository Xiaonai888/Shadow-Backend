create index if not exists idx_author_earnings_export_author_date
on public.author_earnings (author_id, created_at desc, id desc)
where currency = 'diamond'
  and source_type = 'diamond_unlock'
  and earning_status is distinct from 'void';

create or replace function public.author_income_report_group_rows_v1(
  p_author_id uuid,
  p_from date,
  p_to date,
  p_granularity text
)
returns table (
  period_key text,
  story_id uuid,
  transaction_count numeric,
  paid_diamonds numeric,
  author_earned_diamonds numeric,
  author_net_payout_usd numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    case
      when p_granularity in ('story_day', 'day') then to_char(d.earning_day, 'YYYY-MM-DD')
      when p_granularity in ('story_month', 'month') then to_char(d.earning_day, 'YYYY-MM')
      when p_granularity in ('story_year', 'year') then to_char(d.earning_day, 'YYYY')
      else 'Total'
    end as period_key,
    case when p_granularity like 'story_%' then d.story_id else null::uuid end as story_id,
    coalesce(sum(d.transaction_count), 0)::numeric,
    coalesce(sum(d.paid_diamonds), 0)::numeric,
    coalesce(sum(d.author_earned_diamonds), 0)::numeric,
    coalesce(sum(d.author_net_payout_usd), 0)::numeric
  from public.author_income_report_daily d
  where d.author_id = p_author_id
    and d.currency = 'diamond'
    and d.source_type = 'diamond_unlock'
    and d.earning_status <> 'void'
    and (p_from is null or d.earning_day >= p_from)
    and (p_to is null or d.earning_day <= p_to)
  group by 1, 2;
$function$;

create or replace function public.get_author_income_report_export_data_v1(
  p_user_id uuid,
  p_period text default 'month',
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_author_id uuid;
  v_author_name text;
  v_author_username text;
  v_period text := lower(trim(coalesce(p_period, 'month')));
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_from date;
  v_to date;
  v_detail boolean;
  v_mode text;
  v_granularity text;
  v_group_count bigint;
  v_count numeric := 0;
  v_paid numeric := 0;
  v_diamonds numeric := 0;
  v_usd numeric := 0;
  v_rows jsonb := '[]'::jsonb;
  v_check_count numeric;
  v_check_paid numeric;
  v_check_diamonds numeric;
  v_check_usd numeric;
begin
  if p_user_id is null then
    raise exception 'Unauthorized';
  end if;

  if v_period not in ('today', 'week', 'last7', 'last30', 'month', 'year', 'custom', 'all') then
    raise exception 'Invalid income report period';
  end if;

  if v_period = 'today' then
    v_from := v_today;
    v_to := v_today;
  elsif v_period in ('week', 'last7') then
    v_from := v_today - 6;
    v_to := v_today;
  elsif v_period = 'last30' then
    v_from := v_today - 29;
    v_to := v_today;
  elsif v_period = 'month' then
    v_from := date_trunc('month', v_today::timestamp)::date;
    v_to := v_today;
  elsif v_period = 'year' then
    v_from := date_trunc('year', v_today::timestamp)::date;
    v_to := v_today;
  elsif v_period = 'custom' then
    if p_from is null or p_to is null or p_from > p_to then
      raise exception 'Invalid custom income report date range';
    end if;
    v_from := p_from;
    v_to := p_to;
  end if;

  select ap.id, ap.page_name, ap.page_username
  into v_author_id, v_author_name, v_author_username
  from public.author_pages ap
  where ap.user_id = p_user_id
  limit 1;

  if v_author_id is null then
    return jsonb_build_object(
      'ok', true,
      'author', jsonb_build_object('id', null, 'name', '', 'username', ''),
      'range', jsonb_build_object('period', v_period, 'from', v_from, 'to', v_to),
      'mode', 'summary',
      'granularity', 'total',
      'totals', jsonb_build_object('transaction_count', 0, 'paid_diamonds', 0, 'author_earned_diamonds', 0, 'author_net_payout_usd', 0),
      'rows', '[]'::jsonb
    );
  end if;

  select
    coalesce(sum(d.transaction_count), 0),
    coalesce(sum(d.paid_diamonds), 0),
    coalesce(sum(d.author_earned_diamonds), 0),
    coalesce(sum(d.author_net_payout_usd), 0)
  into v_count, v_paid, v_diamonds, v_usd
  from public.author_income_report_daily d
  where d.author_id = v_author_id
    and d.currency = 'diamond'
    and d.source_type = 'diamond_unlock'
    and d.earning_status <> 'void'
    and (v_from is null or d.earning_day >= v_from)
    and (v_to is null or d.earning_day <= v_to);

  v_detail := v_period in ('today', 'week', 'last7')
    or (v_period = 'custom' and (v_to - v_from) < 29);

  if v_detail and v_count <= 500 then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', x.id,
        'created_at', x.created_at,
        'reader_name', x.reader_name,
        'story_id', x.story_id,
        'story_title', x.story_title,
        'episode_number', x.episode_number,
        'paid_diamonds', x.paid_diamonds,
        'author_earned_diamonds', x.author_earned_diamonds,
        'author_net_payout_usd', x.author_net_payout_usd,
        'author_share_percent', x.author_share_percent,
        'earning_status', x.earning_status
      ) order by x.created_at desc, x.id desc
    ), '[]'::jsonb)
    into v_rows
    from (
      select
        ae.id,
        ae.created_at,
        coalesce(u.name, u.username, ae.metadata->>'reader_name', 'Reader') as reader_name,
        ae.story_id,
        coalesce(s.title, ae.metadata->>'story_title', 'Story') as story_title,
        coalesce(e.episode_number, 0) as episode_number,
        coalesce(ae.paid_diamonds, 0) as paid_diamonds,
        coalesce(ae.author_earned_diamonds, 0) as author_earned_diamonds,
        coalesce(ae.author_net_payout_usd, 0) as author_net_payout_usd,
        coalesce(ae.author_share_percent, 0) as author_share_percent,
        coalesce(ae.earning_status, 'unknown') as earning_status
      from public.author_earnings ae
      left join public.users u on u.id = ae.reader_id
      left join public.stories s on s.id = ae.story_id
      left join public.episodes e on e.id = ae.episode_id
      where ae.author_id = v_author_id
        and ae.currency = 'diamond'
        and ae.source_type = 'diamond_unlock'
        and ae.earning_status is distinct from 'void'
        and (v_from is null or ae.created_at >= (v_from::timestamp at time zone 'Asia/Phnom_Penh'))
        and (v_to is null or ae.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Phnom_Penh'))
      order by ae.created_at desc, ae.id desc
      limit 501
    ) x;

    select
      coalesce(sum((x.value->>'paid_diamonds')::numeric), 0),
      coalesce(sum((x.value->>'author_earned_diamonds')::numeric), 0),
      coalesce(sum((x.value->>'author_net_payout_usd')::numeric), 0)
    into v_check_paid, v_check_diamonds, v_check_usd
    from jsonb_array_elements(v_rows) x(value);

    if jsonb_array_length(v_rows) <> v_count or v_check_paid <> v_paid
      or v_check_diamonds <> v_diamonds or v_check_usd <> v_usd then
      raise exception 'Detailed report does not match the financial summary';
    end if;

    v_mode := 'detail';
    v_granularity := 'transaction';
  else
    v_mode := 'summary';
    v_granularity := case
      when v_period = 'all' then 'story_year'
      when v_period = 'year' then 'story_month'
      else 'story_day'
    end;

    loop
      select count(*) into v_group_count
      from (
        select 1
        from public.author_income_report_group_rows_v1(v_author_id, v_from, v_to, v_granularity)
        limit 501
      ) grouped;

      exit when v_group_count <= 500;

      v_granularity := case v_granularity
        when 'story_day' then 'day'
        when 'story_month' then 'month'
        when 'story_year' then 'year'
        when 'day' then 'month'
        when 'month' then 'year'
        else 'total'
      end;
    end loop;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'period', g.period_key,
        'story_id', g.story_id,
        'story_title', case when g.story_id is null then null else coalesce(s.title, 'Story') end,
        'transaction_count', g.transaction_count,
        'paid_diamonds', g.paid_diamonds,
        'author_earned_diamonds', g.author_earned_diamonds,
        'author_net_payout_usd', g.author_net_payout_usd
      ) order by g.period_key asc, g.story_id
    ), '[]'::jsonb)
    into v_rows
    from public.author_income_report_group_rows_v1(v_author_id, v_from, v_to, v_granularity) g
    left join public.stories s on s.id = g.story_id;

    select
      coalesce(sum((x.value->>'transaction_count')::numeric), 0),
      coalesce(sum((x.value->>'paid_diamonds')::numeric), 0),
      coalesce(sum((x.value->>'author_earned_diamonds')::numeric), 0),
      coalesce(sum((x.value->>'author_net_payout_usd')::numeric), 0)
    into v_check_count, v_check_paid, v_check_diamonds, v_check_usd
    from jsonb_array_elements(v_rows) x(value);

    if v_check_count <> v_count or v_check_paid <> v_paid
      or v_check_diamonds <> v_diamonds or v_check_usd <> v_usd then
      raise exception 'Income report totals do not reconcile';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'author', jsonb_build_object('id', v_author_id, 'name', coalesce(v_author_name, ''), 'username', coalesce(v_author_username, '')),
    'range', jsonb_build_object('period', v_period, 'from', v_from, 'to', v_to),
    'mode', v_mode,
    'granularity', v_granularity,
    'totals', jsonb_build_object(
      'transaction_count', v_count,
      'paid_diamonds', v_paid,
      'author_earned_diamonds', v_diamonds,
      'author_net_payout_usd', v_usd
    ),
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.author_income_report_group_rows_v1(uuid, date, date, text) from public, anon, authenticated;
revoke all on function public.get_author_income_report_export_data_v1(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.author_income_report_group_rows_v1(uuid, date, date, text) to service_role;
grant execute on function public.get_author_income_report_export_data_v1(uuid, text, date, date) to service_role;

select
  to_regprocedure('public.author_income_report_group_rows_v1(uuid,date,date,text)') is not null as summary_function_ready,
  to_regprocedure('public.get_author_income_report_export_data_v1(uuid,text,date,date)') is not null as export_function_ready;
