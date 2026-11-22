create or replace function public.author_preorder_launch_readiness_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_check record;
  v_checks jsonb := '{}'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_required integer := 0;
begin
  for v_check in
    select c.check_key, coalesce(c.passed, false) as passed
    from (values
      ('orders_table', to_regclass('public.author_preorder_orders') is not null),
      ('order_items_table', to_regclass('public.author_preorder_order_items') is not null),
      ('payment_intents_table', to_regclass('public.author_preorder_payment_intents') is not null),
      ('legacy_holds_table', to_regclass('public.author_preorder_stock_holds') is not null),
      ('multi_holds_table', to_regclass('public.author_preorder_volume_holds') is not null),
      ('notification_outbox_table', to_regclass('public.author_preorder_paid_notification_outbox') is not null),
      ('multi_hold_rls_enabled', (
        select cls.relrowsecurity from pg_catalog.pg_class cls
        where cls.oid = to_regclass('public.author_preorder_volume_holds')
      )),
      ('outbox_rls_enabled', (
        select cls.relrowsecurity from pg_catalog.pg_class cls
        where cls.oid = to_regclass('public.author_preorder_paid_notification_outbox')
      )),
      ('stock_snapshot_rpc', to_regprocedure('public.author_preorder_stock_snapshot_multivolume(uuid)') is not null),
      ('checkout_rpc', to_regprocedure('public.author_preorder_create_multivolume_held_checkout(uuid,uuid,uuid,jsonb)') is not null),
      ('finalization_rpc', to_regprocedure('public.author_preorder_finalize_multivolume_paid(uuid,text,timestamptz)') is not null),
      ('uninitialized_release_rpc', to_regprocedure('public.author_preorder_release_uninitialized_multivolume_hold(uuid)') is not null),
      ('terminal_release_rpc', to_regprocedure('public.author_preorder_release_verified_multivolume_terminal_hold(uuid,text,uuid,text,text,timestamptz)') is not null),
      ('notification_settlement_rpc', to_regprocedure('public.author_preorder_notification_settlement_verified(uuid,uuid)') is not null),
      ('notification_queue_rpc', to_regprocedure('public.author_preorder_queue_verified_paid_notifications(uuid)') is not null),
      ('notification_worker_rpc', to_regprocedure('public.author_preorder_deliver_inapp_notifications_safe(integer)') is not null),
      ('notification_reference_unique_index', coalesce((
        select idx.indisunique from pg_catalog.pg_index idx
        where idx.indexrelid = to_regclass('public.author_preorder_paid_notification_ref_unique_idx')
      ), false)),
      ('audit_rpc', to_regprocedure('public.author_preorder_record_reconciliation_event(uuid,text,text,text,text)') is not null),
      ('terminal_review_rpc', to_regprocedure('public.author_preorder_record_terminal_review(uuid,text,text)') is not null)
    ) as c(check_key, passed)
  loop
    v_required := v_required + 1;
    v_checks := v_checks || jsonb_build_object(v_check.check_key, v_check.passed);
    if not v_check.passed then
      v_missing := v_missing || jsonb_build_array(v_check.check_key);
    end if;
  end loop;

  return jsonb_build_object(
    'schema_version', 17,
    'required_checks', v_required,
    'checks', v_checks,
    'missing', v_missing,
    'structure_complete', jsonb_array_length(v_missing) = 0,
    'structural_only', true,
    'gateway_payment_verified', false,
    'integration_test_verified', false,
    'ready_to_enable_payment', false,
    'read_only', true,
    'checked_at', now()
  );
end;
$$;

revoke all on function public.author_preorder_launch_readiness_snapshot()
  from public, anon, authenticated;
grant execute on function public.author_preorder_launch_readiness_snapshot()
  to service_role;
