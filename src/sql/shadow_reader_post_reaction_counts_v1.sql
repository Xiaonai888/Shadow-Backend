BEGIN;

CREATE FUNCTION public.shadow_reader_post_reaction_counts_v1(p_post_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
  SELECT jsonb_build_object(
    'love', count(*) FILTER (WHERE reaction_type = 'love'),
    'haha', count(*) FILTER (WHERE reaction_type = 'haha'),
    'wow', count(*) FILTER (WHERE reaction_type = 'wow'),
    'sad', count(*) FILTER (WHERE reaction_type = 'sad'),
    'angry', count(*) FILTER (WHERE reaction_type = 'angry'),
    'support', count(*) FILTER (WHERE reaction_type = 'support'),
    'touched', count(*) FILTER (WHERE reaction_type = 'touched')
  )
  FROM public.reader_post_reactions
  WHERE post_id = p_post_id
    AND reaction_type IN ('love','haha','wow','sad','angry','support','touched');
$fn$;

REVOKE ALL ON FUNCTION public.shadow_reader_post_reaction_counts_v1(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_reader_post_reaction_counts_v1(uuid) TO service_role;

DO $test$
DECLARE
  v_post uuid;
  v_actual jsonb;
  v_expected jsonb;
  v_zero jsonb := '{"love":0,"haha":0,"wow":0,"sad":0,"angry":0,"support":0,"touched":0}'::jsonb;
BEGIN
  IF public.shadow_reader_post_reaction_counts_v1(NULL::uuid) IS DISTINCT FROM v_zero THEN
    RAISE EXCEPTION 'Zero-count test failed';
  END IF;
  FOR v_post IN
    SELECT DISTINCT sample.post_id FROM (
      SELECT post_id FROM public.reader_post_reactions LIMIT 30
    ) sample WHERE sample.post_id IS NOT NULL LIMIT 3
  LOOP
    SELECT v_zero || coalesce(jsonb_object_agg(r.kind, r.tally), '{}'::jsonb)
    INTO v_expected
    FROM (
      SELECT reaction_type::text AS kind, count(*) AS tally
      FROM public.reader_post_reactions
      WHERE post_id = v_post
        AND reaction_type IN ('love','haha','wow','sad','angry','support','touched')
      GROUP BY reaction_type
    ) r;
    v_actual := public.shadow_reader_post_reaction_counts_v1(v_post);
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Reaction counts comparison failed';
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.shadow_reader_post_reaction_counts_v1(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.shadow_reader_post_reaction_counts_v1(uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.shadow_reader_post_reaction_counts_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RPC permission check failed';
  END IF;
END;
$test$;

COMMIT;

SELECT 'PASS' AS result, 'shadow_reader_post_reaction_counts_v1' AS rpc;
