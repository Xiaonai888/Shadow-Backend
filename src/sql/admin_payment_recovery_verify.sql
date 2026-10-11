select
  to_regclass('public.admin_payment_recovery_actions') is not null as audit_table_ready,
  to_regprocedure('public.admin_payment_recovery_apply_v1(text,uuid,uuid,integer,text,numeric,timestamptz,text,text,text)') is not null as recovery_action_ready,
  to_regprocedure('public.admin_release_manual_payment(uuid,text,text)') is not null as existing_diamond_release_ready,
  to_regprocedure('public.release_premium_payment_from_telegram(uuid,uuid,text,text,text)') is not null as existing_premium_release_ready;
