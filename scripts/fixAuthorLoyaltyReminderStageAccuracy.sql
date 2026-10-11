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
  with due_dates as materialized (
    select
      r.author_id,
      r.user_id,
      r.started_at,
      r.ends_at,
      case
        when v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '1 month')::date
          then 'one_month'
        when v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '3 months')::date
          then 'three_months'
        else 'one_year'
      end as reminder_key
    from public.author_loyalty_reward_progress r
    where r.started_at <= now()
      and v_today >= ((r.ends_at at time zone 'Asia/Phnom_Penh') - interval '1 year')::date
      and v_today < (r.ends_at at time zone 'Asia/Phnom_Penh')::date
  ),
  candidates as (
    select d.author_id, d.user_id, d.started_at, d.ends_at, d.reminder_key
    from due_dates d
    join public.author_pages ap on ap.id = d.author_id
    cross join lateral (
      select
        count(*)::integer as episode_count,
        coalesce(sum(coalesce(nullif(e.word_count, 0), e.character_count, 0)), 0) as word_count,
        coalesce(sum(e.total_likes), 0) as like_count
      from public.stories s
      join public.episodes e on e.story_id = s.id
      where s.author_id = d.author_id
        and e.status = 'published'
    ) actual
    where not exists (
      select 1
      from public.author_quest_stages stage
      where stage.is_active is distinct from false
        and stage.share_percent >= 50
        and actual.episode_count >= coalesce(stage.required_episodes, 0)
        and actual.word_count >= coalesce(stage.required_words, 0)
        and actual.like_count >= coalesce(stage.required_likes, 0)
        and coalesce(ap.total_followers, 0) >= coalesce(stage.required_followers, 0)
    )
      and not exists (
        select 1
        from public.author_loyalty_reminder_log l
        where l.author_id = d.author_id
          and l.started_at = d.started_at
          and l.reminder_key = d.reminder_key
      )
    order by d.ends_at, d.author_id
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
