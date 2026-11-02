DO $$
DECLARE
  v_function text;
  v_rpc regprocedure := pg_catalog.to_regprocedure(
    'public.shadow_read_event_redeem_featured_cards(uuid,uuid,uuid)'
  );
BEGIN
  IF pg_catalog.to_regclass('public.shadow_read_event_featured_card_balances') IS NULL
     OR pg_catalog.to_regclass('public.shadow_read_event_featured_card_redemptions') IS NULL
     OR pg_catalog.to_regclass('public.episode_unlocks') IS NULL THEN
    RAISE EXCEPTION 'Read Event Card tables are not installed';
  END IF;

  IF v_rpc IS NULL THEN
    RAISE EXCEPTION 'Read Event Card redemption RPC is missing';
  END IF;

  IF NOT pg_catalog.has_function_privilege('service_role', v_rpc, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_rpc, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'Read Event Card redemption RPC permissions are incorrect';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_rpc) INTO v_function;
  IF pg_catalog.strpos(v_function, 'u.unlock_status = ''expired''') = 0
     OR pg_catalog.strpos(v_function, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_function, 'v_remaining < 10') = 0 THEN
    RAISE EXCEPTION 'Read Event Card redemption v2 is not installed';
  END IF;
END;
$$;
