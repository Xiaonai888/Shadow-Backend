begin;
do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron') then
    raise exception 'Enable pg_cron in Supabase before installing the watchdog';
  end if;
  if coalesce(current_setting('cron.timezone',true),'GMT') not in ('UTC','GMT','Etc/UTC','Etc/GMT') then
    raise exception 'Expected pg_cron timezone UTC or GMT; verify before installing the watchdog';
  end if;
  if to_regprocedure('public.telegram_promotion_watchdog_v1()') is null then
    raise exception 'Install 06_monitoring.sql first';
  end if;
end;
$$;
select cron.schedule('shadow-telegram-promotion-watchdog','0 0,4,11 * * *','select public.telegram_promotion_watchdog_v1()');
commit;
