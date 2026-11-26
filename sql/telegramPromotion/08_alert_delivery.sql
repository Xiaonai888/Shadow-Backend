begin;
create table if not exists public.telegram_promotion_alert_delivery (
  checkpoint_at timestamptz primary key,
  claimed_at timestamptz not null default now(),
  status text not null default 'sending' check(status in ('sending','sent','uncertain')),
  telegram_message_id bigint,
  finished_at timestamptz,
  last_error text check(last_error is null or length(last_error)<=300)
);
alter table public.telegram_promotion_alert_delivery enable row level security;
revoke all on public.telegram_promotion_alert_delivery from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_alert_delivery to service_role;
create or replace function public.telegram_promotion_claim_alert_v1(p_checkpoint timestamptz,p_chat_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_rows jsonb; v_claim timestamptz;
begin
  if p_checkpoint is null or p_checkpoint>now() or p_checkpoint<now()-interval '24 hours' then raise exception 'Invalid alert checkpoint'; end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{5,20}$' or exists(select 1 from public.telegram_promotion_settings where channel_id=p_chat_id) then raise exception 'Configure a separate admin alert chat'; end if;
  delete from public.telegram_promotion_alert_delivery where checkpoint_at<now()-interval '30 days';
  if exists(select 1 from public.telegram_promotion_alert_delivery where checkpoint_at=p_checkpoint) then return jsonb_build_object('ready',true,'rows','[]'::jsonb); end if;
  if exists(select 1 from public.telegram_promotion_settings s where s.enabled and s.enabled_at<=p_checkpoint and not exists(select 1 from public.telegram_promotion_watchdog_history h where h.language=s.language and h.checkpoint_at=p_checkpoint)) then
    return jsonb_build_object('ready',false,'rows','[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('language',h.language,'worker_state',h.worker_state,'missing_events',h.missing_events,'failed_posts',h.failed_posts,'uncertain_posts',h.uncertain_posts,'checked_at',h.checked_at) order by h.language),'[]'::jsonb) into v_rows
  from public.telegram_promotion_watchdog_history h join public.telegram_promotion_settings s on s.language=h.language and s.enabled and s.enabled_at<=p_checkpoint
  where h.checkpoint_at=p_checkpoint and (h.worker_state in ('stale','error') or h.missing_events>0 or h.failed_posts>0 or h.uncertain_posts>0);
  if jsonb_array_length(v_rows)=0 then return jsonb_build_object('ready',true,'rows',v_rows); end if;
  insert into public.telegram_promotion_alert_delivery(checkpoint_at) values(p_checkpoint) on conflict do nothing returning checkpoint_at into v_claim;
  return jsonb_build_object('ready',true,'rows',case when v_claim is null then '[]'::jsonb else v_rows end);
end;
$$;
revoke all on function public.telegram_promotion_claim_alert_v1(timestamptz,text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_claim_alert_v1(timestamptz,text) to service_role;
commit;
select to_regclass('public.telegram_promotion_alert_delivery') is not null as alert_table_ready,
 to_regprocedure('public.telegram_promotion_claim_alert_v1(timestamptz,text)') is not null as alert_rpc_ready;
