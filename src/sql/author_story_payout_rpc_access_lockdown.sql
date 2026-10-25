BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.generate_author_payouts(text)',
    'public.record_author_story_payout_transfer(uuid,text)',
    'public.mark_author_payout_paid(uuid,text)',
    'public.get_author_story_payout_balance(uuid)'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Missing payout function: %', signature;
    END IF;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_author_payouts(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_author_story_payout_transfer(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_author_payout_paid(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_author_story_payout_balance(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.generate_author_payouts(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_author_story_payout_transfer(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_author_payout_paid(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_author_story_payout_balance(uuid) TO service_role;

DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.generate_author_payouts(text)',
    'public.record_author_story_payout_transfer(uuid,text)',
    'public.mark_author_payout_paid(uuid,text)',
    'public.get_author_story_payout_balance(uuid)'
  ] LOOP
    IF has_function_privilege('anon', signature, 'EXECUTE')
       OR has_function_privilege('authenticated', signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unsafe payout RPC access: %', signature;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
