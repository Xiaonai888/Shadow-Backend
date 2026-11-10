BEGIN;

-- Run AFTER smart_ad_engine_core_v1.sql. All reader APIs remain unchanged.
-- Prevent a daily/weekly refresh from resurrecting stories revoked while
-- the JS worker was scanning candidates.
CREATE OR REPLACE FUNCTION public.smart_ad_pool_reconcile_v1(
  p_records jsonb, p_capacity integer, p_weekly boolean DEFAULT false
)
RETURNS TABLE (catalog_version bigint, active_count bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_length integer;
  v_valid_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Smart Ad records must be an array';
  END IF;
  v_length := jsonb_array_length(p_records);
  IF v_length > 3000 OR p_capacity IS NULL OR p_capacity NOT BETWEEN 1000 AND 3000
    OR p_capacity % 250 <> 0 OR v_length > p_capacity THEN
    RAISE EXCEPTION 'Smart Ad pool capacity or payload is invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(861029401);
  INSERT INTO public.smart_ad_engine_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

  WITH input AS MATERIALIZED (
    SELECT DISTINCT ON (r.story_id)
      r.story_id, r.priority_score
    FROM jsonb_to_recordset(p_records) AS r(
      story_id uuid, story_kind text, priority_score numeric
    )
    WHERE r.story_id IS NOT NULL
      AND r.priority_score IS NOT NULL
    ORDER BY r.story_id
  ), published AS (
    SELECT e.story_id, COUNT(*)::bigint AS episode_count,
      MAX(COALESCE(e.first_published_at, e.published_at)) AS latest_publish_at
    FROM public.episodes e JOIN input i ON i.story_id = e.story_id
    WHERE e.status = 'published' AND e.deleted_at IS NULL
      AND COALESCE(e.first_published_at, e.published_at) IS NOT NULL
      AND COALESCE(e.first_published_at, e.published_at) <= now()
      AND (e.published_at IS NULL OR e.published_at <= now())
    GROUP BY e.story_id
  ), classified AS (
    SELECT i.story_id, i.priority_score, ep.episode_count,
      ep.latest_publish_at,
      LOWER(COALESCE(s.story_status, '')) = 'completed' AS is_completed,
      CASE
        WHEN LOWER(COALESCE(s.story_type, 'novel')) IN
             ('short', 'short_story', 'short_novel') THEN 'short'
        WHEN LOWER(COALESCE(s.story_type, 'novel')) = 'novel'
             AND LOWER(COALESCE(s.story_status, '')) = 'completed'
             AND ep.episode_count <= 9 THEN 'short'
        WHEN LOWER(COALESCE(s.story_type, 'novel')) = 'novel' THEN 'novel'
        ELSE 'unsupported'
      END AS story_kind
    FROM input i
    JOIN public.stories s ON s.id = i.story_id
    JOIN published ep ON ep.story_id = i.story_id
    WHERE s.status = 'published' AND s.deleted_at IS NULL
      AND NULLIF(BTRIM(s.title), '') IS NOT NULL
      AND COALESCE(s.admin_visibility_status, 'active') = 'active'
      AND NOT COALESCE(s.is_adult, false)
      AND (NOT COALESCE(s.is_shadow_exclusive, false)
           OR s.exclusive_status = 'approved')
  ), valid AS (
    SELECT c.* FROM classified c
    WHERE ((c.story_kind = 'short' AND c.is_completed)
        OR (c.story_kind = 'novel' AND c.episode_count >= 5))
      AND (c.is_completed
        OR c.latest_publish_at >= now() - interval '90 days')
  ), upserted AS (
    INSERT INTO public.smart_ad_active_pool
      (story_id, story_kind, priority_score, checked_at)
    SELECT v.story_id, v.story_kind, v.priority_score, now()
    FROM valid v
    ON CONFLICT (story_id) DO UPDATE
      SET story_kind = EXCLUDED.story_kind,
          priority_score = EXCLUDED.priority_score,
          checked_at = EXCLUDED.checked_at
    RETURNING story_id
  )
  SELECT COALESCE(ARRAY_AGG(story_id), ARRAY[]::uuid[])
    INTO v_valid_ids FROM upserted;

  DELETE FROM public.smart_ad_active_pool p
  WHERE NOT (p.story_id = ANY(v_valid_ids));

  UPDATE public.smart_ad_engine_state s
  SET capacity = p_capacity,
      catalog_version = s.catalog_version + 1,
      last_daily_check_at = now(),
      last_weekly_refresh_at = CASE
        WHEN p_weekly THEN now() ELSE s.last_weekly_refresh_at END
  WHERE s.id = 1;

  RETURN QUERY
  SELECT s.catalog_version,
    (SELECT COUNT(*)::bigint FROM public.smart_ad_active_pool)
  FROM public.smart_ad_engine_state s WHERE s.id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_pool_reconcile_v1(jsonb, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_pool_reconcile_v1(jsonb, integer, boolean)
  TO service_role;

-- Serialize visibility removal with reconciliation. Without this lock a
-- concurrent refresh could reinsert a story after the old trigger deleted it.
CREATE OR REPLACE FUNCTION public.smart_ad_story_visibility_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_removed bigint := 0;
  v_story_id uuid;
  v_remove boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_story_id := OLD.id;
    v_remove := true;
  ELSE
    v_story_id := NEW.id;
    v_remove := NEW.status IS DISTINCT FROM 'published'
      OR NEW.deleted_at IS NOT NULL
      OR COALESCE(NEW.admin_visibility_status, 'active') <> 'active'
      OR COALESCE(NEW.is_adult, false)
      OR (COALESCE(NEW.is_shadow_exclusive, false)
          AND COALESCE(NEW.exclusive_status, '') <> 'approved');
  END IF;
  IF v_remove THEN
    PERFORM pg_advisory_xact_lock(861029401);
    DELETE FROM public.smart_ad_active_pool WHERE story_id = v_story_id;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    IF v_removed > 0 THEN
      UPDATE public.smart_ad_engine_state
      SET catalog_version = catalog_version + 1 WHERE id = 1;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- A published-episode change and a refresh use the same serialization lock.
CREATE OR REPLACE FUNCTION public.smart_ad_pool_revalidate_story_v1(p_story_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_story public.stories%ROWTYPE;
  v_count bigint;
  v_last timestamptz;
  v_kind text;
  v_completed boolean;
  v_valid boolean;
  v_modified bigint := 0;
BEGIN
  IF p_story_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(861029401);
  IF NOT EXISTS (
    SELECT 1 FROM public.smart_ad_active_pool WHERE story_id = p_story_id
  ) THEN RETURN; END IF;
  SELECT * INTO v_story FROM public.stories WHERE id = p_story_id;
  IF NOT FOUND THEN
    DELETE FROM public.smart_ad_active_pool WHERE story_id = p_story_id;
    GET DIAGNOSTICS v_modified = ROW_COUNT;
  ELSE
    SELECT COUNT(*), MAX(COALESCE(e.first_published_at, e.published_at))
      INTO v_count, v_last FROM public.episodes e
    WHERE e.story_id = p_story_id AND e.status = 'published'
      AND e.deleted_at IS NULL
      AND COALESCE(e.first_published_at, e.published_at) IS NOT NULL
      AND COALESCE(e.first_published_at, e.published_at) <= now()
      AND (e.published_at IS NULL OR e.published_at <= now());
    v_completed := LOWER(COALESCE(v_story.story_status, '')) = 'completed';
    v_kind := CASE
      WHEN LOWER(COALESCE(v_story.story_type, 'novel')) IN
           ('short', 'short_story', 'short_novel') THEN 'short'
      WHEN LOWER(COALESCE(v_story.story_type, 'novel')) = 'novel'
           AND v_completed AND v_count <= 9 THEN 'short'
      WHEN LOWER(COALESCE(v_story.story_type, 'novel')) = 'novel' THEN 'novel'
      ELSE 'unsupported'
    END;
    v_valid := v_story.status = 'published' AND v_story.deleted_at IS NULL
      AND NULLIF(BTRIM(v_story.title), '') IS NOT NULL
      AND COALESCE(v_story.admin_visibility_status, 'active') = 'active'
      AND NOT COALESCE(v_story.is_adult, false)
      AND (NOT COALESCE(v_story.is_shadow_exclusive, false)
           OR v_story.exclusive_status = 'approved')
      AND v_count > 0 AND v_last IS NOT NULL
      AND ((v_kind = 'short' AND v_completed)
        OR (v_kind = 'novel' AND v_count >= 5))
      AND (v_completed OR v_last >= now() - interval '90 days');
    IF v_valid THEN
      UPDATE public.smart_ad_active_pool
      SET story_kind = v_kind, checked_at = now()
      WHERE story_id = p_story_id;
    ELSE
      DELETE FROM public.smart_ad_active_pool WHERE story_id = p_story_id;
    END IF;
    GET DIAGNOSTICS v_modified = ROW_COUNT;
  END IF;
  IF v_modified > 0 THEN
    UPDATE public.smart_ad_engine_state
    SET catalog_version = catalog_version + 1 WHERE id = 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_pool_revalidate_story_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMIT;
