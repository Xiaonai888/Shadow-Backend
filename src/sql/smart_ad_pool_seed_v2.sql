BEGIN;

-- Run AFTER smart_ad_engine_core_v1.sql. Installation does not change the pool.
-- This service-role-only function populates empty slots on explicit admin request.
CREATE OR REPLACE FUNCTION public.smart_ad_bootstrap_pool_v2(
  p_target integer DEFAULT 1000,
  p_scan_limit integer DEFAULT 12000
)
RETURNS TABLE (inserted_count bigint, active_count bigint, catalog_version bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted bigint := 0;
  v_capacity integer;
  v_slots integer;
BEGIN
  IF p_target IS NULL OR p_target NOT BETWEEN 1000 AND 3000
     OR p_target % 250 <> 0 THEN
    RAISE EXCEPTION 'Invalid Smart Ad bootstrap target';
  END IF;
  IF p_scan_limit IS NULL OR p_scan_limit NOT BETWEEN 100 AND 12000 THEN
    RAISE EXCEPTION 'Invalid Smart Ad scan limit';
  END IF;

  PERFORM pg_advisory_xact_lock(861029401);
  SELECT capacity INTO v_capacity
  FROM public.smart_ad_engine_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Smart Ad core migration must be installed first';
  END IF;

  -- Never silently expand capacity. Only the ordinary weekly refresh may expand it.
  IF p_target > v_capacity THEN
    RAISE EXCEPTION 'Requested bootstrap target exceeds active capacity';
  END IF;
  SELECT GREATEST(0, p_target - COUNT(*))::integer INTO v_slots
  FROM public.smart_ad_active_pool;

  IF v_slots > 0 THEN
    WITH candidates AS MATERIALIZED (
      SELECT s.id, s.story_type, s.story_status, s.total_views
      FROM public.stories s
      WHERE s.status = 'published'
        AND s.deleted_at IS NULL
        AND NULLIF(BTRIM(s.title), '') IS NOT NULL
        AND COALESCE(s.admin_visibility_status, 'active') = 'active'
        AND NOT COALESCE(s.is_adult, false)
        AND (NOT COALESCE(s.is_shadow_exclusive, false)
             OR s.exclusive_status = 'approved')
        AND LOWER(COALESCE(s.story_type, 'novel')) IN
            ('novel', 'short', 'short_story', 'short_novel')
        AND NOT EXISTS (
          SELECT 1 FROM public.smart_ad_active_pool p WHERE p.story_id = s.id
        )
      ORDER BY s.total_views ASC NULLS LAST, s.id ASC
      LIMIT p_scan_limit
    ), published AS (
      SELECT e.story_id, COUNT(*)::bigint AS episode_count,
        MAX(COALESCE(e.first_published_at, e.published_at)) AS latest_publish_at
      FROM public.episodes e
      JOIN candidates c ON c.id = e.story_id
      WHERE e.status = 'published'
        AND e.deleted_at IS NULL
        AND COALESCE(e.first_published_at, e.published_at) IS NOT NULL
        AND COALESCE(e.first_published_at, e.published_at) <= now()
        AND (e.published_at IS NULL OR e.published_at <= now())
      GROUP BY e.story_id
    ), classified AS (
      SELECT c.id, c.total_views, p.episode_count, p.latest_publish_at,
        (LOWER(COALESCE(c.story_status, '')) = 'completed') AS is_completed,
        CASE
          WHEN LOWER(COALESCE(c.story_type, 'novel')) IN
               ('short', 'short_story', 'short_novel') THEN 'short'
          WHEN LOWER(COALESCE(c.story_type, 'novel')) = 'novel'
               AND LOWER(COALESCE(c.story_status, '')) = 'completed'
               AND p.episode_count <= 9 THEN 'short'
          ELSE 'novel'
        END AS story_kind
      FROM candidates c
      JOIN published p ON p.story_id = c.id
    ), eligible AS (
      SELECT c.* FROM classified c
      WHERE ((c.story_kind = 'short' AND c.is_completed)
          OR (c.story_kind = 'novel' AND c.episode_count >= 5))
        AND (c.is_completed
          OR c.latest_publish_at >= now() - interval '90 days')
    )
    INSERT INTO public.smart_ad_active_pool
      (story_id, story_kind, priority_score, selected_at, checked_at)
    SELECT e.id, e.story_kind,
      (100.0 / (1.0 + LN(1.0 + GREATEST(0.0, COALESCE(e.total_views, 0)::numeric))))
        + CASE WHEN e.latest_publish_at >= now() - interval '30 days' THEN 30 ELSE 0 END,
      now(), now()
    FROM eligible e
    ORDER BY e.total_views ASC NULLS LAST, e.id ASC
    LIMIT v_slots
    ON CONFLICT (story_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  IF v_inserted > 0 THEN
    UPDATE public.smart_ad_engine_state AS state
    SET catalog_version = state.catalog_version + 1,
        last_daily_check_at = now()
    WHERE state.id = 1;
  END IF;

  RETURN QUERY
  SELECT v_inserted,
    (SELECT COUNT(*)::bigint FROM public.smart_ad_active_pool),
    s.catalog_version
  FROM public.smart_ad_engine_state s WHERE s.id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_bootstrap_pool_v2(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_bootstrap_pool_v2(integer, integer)
  TO service_role;

COMMIT;
