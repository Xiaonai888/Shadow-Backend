-- Install once in Supabase SQL Editor before connecting the new JS services.
-- This migration creates only shared Smart Ad metadata; it does not alter
-- Discover, Advertisement, Manual Ads, Episodes, or reader unlock tables.

CREATE TABLE IF NOT EXISTS public.smart_ad_engine_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  capacity integer NOT NULL DEFAULT 1000 CHECK (capacity BETWEEN 1000 AND 3000 AND capacity % 250 = 0),
  catalog_version bigint NOT NULL DEFAULT 1,
  last_daily_check_at timestamptz,
  last_weekly_refresh_at timestamptz
);

INSERT INTO public.smart_ad_engine_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.smart_ad_active_pool (
  story_id uuid PRIMARY KEY REFERENCES public.stories(id) ON DELETE CASCADE,
  story_kind text NOT NULL CHECK (story_kind IN ('novel', 'short')),
  priority_score numeric NOT NULL DEFAULT 0,
  selected_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS smart_ad_pool_priority_idx
ON public.smart_ad_active_pool (priority_score DESC, story_id ASC);

CREATE INDEX IF NOT EXISTS smart_ad_episodes_summary_idx
ON public.episodes (story_id, episode_number, first_published_at DESC)
WHERE deleted_at IS NULL AND status = 'published';

ALTER TABLE public.smart_ad_engine_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_ad_active_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_ad_engine_state FROM anon, authenticated;
REVOKE ALL ON TABLE public.smart_ad_active_pool FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.smart_ad_engine_state TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.smart_ad_active_pool TO service_role;

-- One bounded, set-based query verifies real published episode counts,
-- publication freshness, and the canonical first episode ID.
CREATE OR REPLACE FUNCTION public.smart_ad_episode_summaries_v1(p_story_ids uuid[])
RETURNS TABLE (
  story_id uuid,
  published_episode_count bigint,
  first_episode_id uuid,
  last_episode_published_at timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH ids AS (
    SELECT DISTINCT unnest(p_story_ids) AS id
    WHERE cardinality(p_story_ids) BETWEEN 1 AND 100
  ), published AS (
    SELECT e.story_id, e.id, e.episode_number,
      COALESCE(e.first_published_at, e.published_at) AS published_time,
      ROW_NUMBER() OVER (
        PARTITION BY e.story_id
        ORDER BY e.episode_number ASC NULLS LAST, e.created_at ASC, e.id ASC
      ) AS episode_position
    FROM public.episodes e
    JOIN ids ON ids.id = e.story_id
    WHERE e.status = 'published'
      AND e.deleted_at IS NULL
      AND COALESCE(e.first_published_at, e.published_at) IS NOT NULL
      AND COALESCE(e.first_published_at, e.published_at) <= now()
      AND (e.published_at IS NULL OR e.published_at <= now())
  )
  SELECT ids.id,
    COUNT(published.id)::bigint,
    (ARRAY_AGG(published.id) FILTER (WHERE published.episode_position = 1))[1] AS first_episode_id,
    MAX(published.published_time)
  FROM ids LEFT JOIN published ON published.story_id = ids.id
  GROUP BY ids.id;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_episode_summaries_v1(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_episode_summaries_v1(uuid[]) TO service_role;

-- A single atomic, service-role-only reconciliation is used by the future
-- daily/weekly worker. It never executes during the normal reader GET path.
CREATE OR REPLACE FUNCTION public.smart_ad_pool_reconcile_v1(
  p_records jsonb, p_capacity integer, p_weekly boolean DEFAULT false
)
RETURNS TABLE (catalog_version bigint, active_count bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_length integer;
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
  INSERT INTO public.smart_ad_engine_state(id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.smart_ad_active_pool(story_id, story_kind, priority_score, checked_at)
  SELECT r.story_id, r.story_kind, r.priority_score, now()
  FROM jsonb_to_recordset(p_records) AS r(
    story_id uuid, story_kind text, priority_score numeric
  )
  ON CONFLICT (story_id) DO UPDATE
  SET story_kind = EXCLUDED.story_kind,
      priority_score = EXCLUDED.priority_score,
      checked_at = EXCLUDED.checked_at;

  DELETE FROM public.smart_ad_active_pool p
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_records) AS r(
      story_id uuid, story_kind text, priority_score numeric
    ) WHERE r.story_id = p.story_id
  );

  UPDATE public.smart_ad_engine_state s
  SET capacity = p_capacity,
      catalog_version = s.catalog_version + 1,
      last_daily_check_at = now(),
      last_weekly_refresh_at = CASE WHEN p_weekly THEN now() ELSE s.last_weekly_refresh_at END
  WHERE s.id = 1;

  RETURN QUERY SELECT s.catalog_version, (SELECT COUNT(*) FROM public.smart_ad_active_pool)
  FROM public.smart_ad_engine_state s WHERE s.id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_pool_reconcile_v1(jsonb, integer, boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_pool_reconcile_v1(jsonb, integer, boolean)
TO service_role;

CREATE OR REPLACE FUNCTION public.smart_ad_pool_remove_v1(p_story_ids uuid[])
RETURNS TABLE (catalog_version bigint, removed_count bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_removed bigint;
BEGIN
  IF p_story_ids IS NULL OR cardinality(p_story_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Supply 1 to 100 story ids';
  END IF;
  PERFORM pg_advisory_xact_lock(861029401);
  DELETE FROM public.smart_ad_active_pool WHERE story_id = ANY(p_story_ids);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  UPDATE public.smart_ad_engine_state s
  SET catalog_version = s.catalog_version + 1 WHERE s.id = 1;
  RETURN QUERY SELECT s.catalog_version, v_removed FROM public.smart_ad_engine_state s WHERE s.id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_pool_remove_v1(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_pool_remove_v1(uuid[]) TO service_role;

-- Immediate database-level removal on story unpublish/delete/restriction.
-- The frontend invalidation channel and episode-mutation hooks are connected
-- in the later integration stage, after reviewing all existing mutation paths.
CREATE OR REPLACE FUNCTION public.smart_ad_story_visibility_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_story_id uuid;
  v_removed bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_story_id := OLD.id;
  ELSE
    v_story_id := NEW.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.smart_ad_active_pool WHERE story_id = v_story_id;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    IF v_removed > 0 THEN
      UPDATE public.smart_ad_engine_state SET catalog_version = catalog_version + 1 WHERE id = 1;
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.status IS DISTINCT FROM 'published' OR NEW.deleted_at IS NOT NULL OR
     COALESCE(NEW.admin_visibility_status, 'active') <> 'active' OR
     COALESCE(NEW.is_adult, false) OR
     (COALESCE(NEW.is_shadow_exclusive, false) AND COALESCE(NEW.exclusive_status, '') <> 'approved') THEN
    DELETE FROM public.smart_ad_active_pool WHERE story_id = v_story_id;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    IF v_removed > 0 THEN
      UPDATE public.smart_ad_engine_state SET catalog_version = catalog_version + 1 WHERE id = 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS smart_ad_story_visibility_guard_v1 ON public.stories;
CREATE TRIGGER smart_ad_story_visibility_guard_v1
AFTER UPDATE OF status, deleted_at, admin_visibility_status, is_adult, is_shadow_exclusive, exclusive_status
OR DELETE ON public.stories
FOR EACH ROW EXECUTE FUNCTION public.smart_ad_story_visibility_guard_v1();

-- Episode mutations can invalidate an Ad immediately, even before a daily
-- pool refresh. Only stories already in the active pool are rechecked.
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
BEGIN
  IF p_story_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.smart_ad_active_pool WHERE story_id = p_story_id
  ) THEN RETURN; END IF;
  SELECT * INTO v_story FROM public.stories WHERE id = p_story_id;
  IF NOT FOUND THEN
    DELETE FROM public.smart_ad_active_pool WHERE story_id = p_story_id;
    UPDATE public.smart_ad_engine_state SET catalog_version = catalog_version + 1 WHERE id = 1;
    RETURN;
  END IF;
  SELECT COUNT(*), MAX(COALESCE(e.first_published_at, e.published_at))
    INTO v_count, v_last
  FROM public.episodes e WHERE e.story_id = p_story_id
    AND e.status = 'published' AND e.deleted_at IS NULL
    AND COALESCE(e.first_published_at, e.published_at) <= now()
    AND (e.published_at IS NULL OR e.published_at <= now());
  v_completed := lower(COALESCE(v_story.story_status, '')) = 'completed';
  v_kind := CASE
    WHEN lower(COALESCE(v_story.story_type, 'novel')) IN ('short', 'short_story', 'short_novel') THEN 'short'
    WHEN lower(COALESCE(v_story.story_type, 'novel')) = 'novel' AND v_completed AND v_count <= 9 THEN 'short'
    WHEN lower(COALESCE(v_story.story_type, 'novel')) = 'novel' THEN 'novel'
    ELSE 'unsupported' END;
  v_valid := v_story.status = 'published' AND v_story.deleted_at IS NULL
    AND COALESCE(v_story.admin_visibility_status, 'active') = 'active'
    AND NOT COALESCE(v_story.is_adult, false)
    AND (NOT COALESCE(v_story.is_shadow_exclusive, false) OR v_story.exclusive_status = 'approved')
    AND v_count > 0 AND v_last IS NOT NULL
    AND ((v_kind = 'short' AND v_completed) OR (v_kind = 'novel' AND v_count >= 5))
    AND (v_completed OR v_last >= now() - interval '90 days');
  IF NOT v_valid THEN
    DELETE FROM public.smart_ad_active_pool WHERE story_id = p_story_id;
  ELSE
    UPDATE public.smart_ad_active_pool
      SET story_kind = v_kind, checked_at = now() WHERE story_id = p_story_id;
  END IF;
  UPDATE public.smart_ad_engine_state SET catalog_version = catalog_version + 1 WHERE id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_pool_revalidate_story_v1(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.smart_ad_pool_episode_change_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.story_id IS DISTINCT FROM NEW.story_id THEN
    PERFORM public.smart_ad_pool_revalidate_story_v1(OLD.story_id);
  END IF;
  PERFORM public.smart_ad_pool_revalidate_story_v1(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.story_id ELSE NEW.story_id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS smart_ad_pool_episode_change_v1 ON public.episodes;
CREATE TRIGGER smart_ad_pool_episode_change_v1
AFTER INSERT OR UPDATE OF status, deleted_at, first_published_at, published_at, episode_number
OR DELETE ON public.episodes
FOR EACH ROW EXECUTE FUNCTION public.smart_ad_pool_episode_change_v1();

CREATE OR REPLACE FUNCTION public.smart_ad_pool_story_type_change_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.smart_ad_pool_revalidate_story_v1(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS smart_ad_pool_story_type_change_v1 ON public.stories;
CREATE TRIGGER smart_ad_pool_story_type_change_v1
AFTER UPDATE OF story_status, story_type ON public.stories
FOR EACH ROW EXECUTE FUNCTION public.smart_ad_pool_story_type_change_v1();
