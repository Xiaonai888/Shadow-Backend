BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_admin_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  admin_id uuid NOT NULL,
  previous_enabled boolean NOT NULL,
  new_enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT shadow_read_event_status_changed CHECK (previous_enabled <> new_enabled)
);

CREATE INDEX IF NOT EXISTS shadow_read_event_admin_status_history_event_idx
  ON public.shadow_read_event_admin_status_history (event_id, changed_at DESC);

ALTER TABLE public.shadow_read_event_admin_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shadow_read_event_admin_status_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.shadow_read_event_admin_status_history TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_read_event_set_enabled(
  p_event_id uuid, p_enabled boolean, p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_start date;
  v_old_enabled boolean;
  v_group text;
  v_story text;
  v_missions integer;
  v_bad_missions integer;
  v_milestones integer;
  v_bad_milestones integer;
  v_daily_stories integer;
BEGIN
  IF p_event_id IS NULL OR p_enabled IS NULL OR p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Read Event status parameters required' USING ERRCODE = '22023';
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group, w.featured_story_id
    INTO v_start, v_old_enabled, v_group, v_story
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id
  FOR UPDATE;

  IF NOT FOUND OR v_group IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event not found' USING ERRCODE = '22023';
  END IF;

  IF v_old_enabled IS NOT DISTINCT FROM p_enabled THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'changed', false, 'event_id', p_event_id,
      'starts_on', v_start, 'is_enabled', v_old_enabled
    );
  END IF;

  IF v_today >= v_start + 7 THEN
    RAISE EXCEPTION 'Finished Read Events cannot change enabled state'
      USING ERRCODE = '22023';
  END IF;

  IF p_enabled THEN
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (WHERE
             m.max_points IS DISTINCT FROM
               (CASE m.slot WHEN 1 THEN 300 WHEN 2 THEN 220 WHEN 3 THEN 190
                 WHEN 4 THEN 160 WHEN 5 THEN 130 ELSE -1 END)
             OR (m.slot = 1 AND (m.mission_type <> 'daily_story' OR m.story_id IS NULL
                                  OR m.story_id = v_story))
             OR (m.slot <> 1 AND (m.mission_type = 'daily_story' OR m.story_id IS NOT NULL))
           )::integer
      INTO v_missions, v_bad_missions
    FROM public.shadow_read_event_missions AS m
    WHERE m.event_id = p_event_id;

    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (WHERE
             m.required_points IS DISTINCT FROM m.tier * 200 OR
             m.coin_reward IS DISTINCT FROM
               (CASE m.tier WHEN 1 THEN 25 WHEN 2 THEN 50 WHEN 3 THEN 75
                 WHEN 4 THEN 100 WHEN 5 THEN 150 ELSE -1 END)
           )::integer
      INTO v_milestones, v_bad_milestones
    FROM public.shadow_read_event_milestones AS m
    WHERE m.event_id = p_event_id;

    SELECT pg_catalog.count(*)::integer INTO v_daily_stories
    FROM public.shadow_read_event_missions AS m
    JOIN public.stories AS s ON s.id::text = m.story_id
    WHERE m.event_id = p_event_id AND m.slot = 1
      AND s.status = 'published' AND s.deleted_at IS NULL
      AND COALESCE(s.total_episodes, 0) >= 2
      AND COALESCE(s.is_adult, false) = false
      AND COALESCE(s.is_shadow_exclusive, false) = false
      AND COALESCE(s.admin_visibility_status, 'active') = 'active'
      AND pg_catalog.lower(COALESCE(s.access_type, 'free')) = 'free';

    IF v_missions <> 35 OR v_bad_missions <> 0 OR
       v_milestones <> 35 OR v_bad_milestones <> 0 OR v_daily_stories <> 7 OR
       NOT EXISTS (
         SELECT 1 FROM public.stories AS s
         WHERE s.id::text = v_story
           AND s.status = 'published' AND s.deleted_at IS NULL
           AND pg_catalog.lower(pg_catalog.btrim(s.story_status)) = 'completed'
           AND COALESCE(s.total_episodes, 0) >= 10
       ) THEN
      RAISE EXCEPTION 'Read Event plan or featured story is not eligible'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.shadow_read_event_weeks AS w
     SET is_enabled = p_enabled, updated_at = v_now
   WHERE w.id = p_event_id;

  INSERT INTO public.shadow_read_event_admin_status_history (
    event_id, admin_id, previous_enabled, new_enabled, changed_at
  ) VALUES (p_event_id, p_admin_id, v_old_enabled, p_enabled, v_now);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'changed', true, 'event_id', p_event_id,
    'starts_on', v_start, 'is_enabled', p_enabled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_set_enabled(uuid, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_set_enabled(uuid, boolean, uuid)
  TO service_role;

COMMIT;
