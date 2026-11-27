begin;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname='pg_cron')
    or pg_catalog.to_regprocedure('public.shadow_ai_cleanup_expired_drafts_v1()') is null then
    raise exception 'Install pg_cron and the Shadow AI retention migration first';
  end if;
end;
$$;
select cron.schedule('shadow-ai-expired-drafts-v1','17 * * * *','select public.shadow_ai_cleanup_expired_drafts_v1()');
commit;
