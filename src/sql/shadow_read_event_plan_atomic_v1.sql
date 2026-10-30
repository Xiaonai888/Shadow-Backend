BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_save_plan(p_plan jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start_text text;
  v_start date;
  v_featured_story text;
  v_event_id uuid;
  v_existing_enabled boolean;
  v_count integer;
  v_distinct_count integer;
BEGIN
  IF pg_catalog.jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_plan -> 'week') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_plan -> 'missions') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_plan -> 'milestones') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Invalid Shadow Read Event plan payload' USING ERRCODE = '22023';
  END IF;

  v_start_text := p_plan #>> '{week,starts_on}';
  v_featured_story := pg_catalog.btrim(COALESCE(p_plan #>> '{week,featured_story_id}', ''));

  IF v_start_text IS NULL OR v_start_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR pg_catalog.length(v_featured_story) NOT BETWEEN 1 AND 128
     OR p_plan #>> '{week,audience_group}' IS DISTINCT FROM 'kh'
     OR p_plan #>> '{week,is_enabled}' IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION 'Invalid Shadow Read Event week configuration' USING ERRCODE = '22023';
  END IF;

  v_start := v_start_text::date;

  IF pg_catalog.to_char(v_start, 'YYYY-MM-DD') <> v_start_text
     OR v_start < DATE '2026-11-02'
     OR (v_start - DATE '2026-11-02') % 28 <> 0
     OR EXTRACT(ISODOW FROM v_start) <> 1
  THEN
    RAISE EXCEPTION 'Event must start on its 28-day Monday cycle' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_array_length(p_plan -> 'missions') <> 35
     OR pg_catalog.jsonb_array_length(p_plan -> 'milestones') <> 35
  THEN
    RAISE EXCEPTION 'Plan requires exactly 35 missions and 35 milestones' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(DISTINCT (m.day_number, m.slot))
    INTO v_distinct_count
  FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
    day_number integer, slot integer, mission_type text, story_id text,
    mission_params jsonb, target_amount integer, max_points integer
  );

  IF v_distinct_count <> 35 OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
      day_number integer, slot integer, mission_type text, story_id text,
      mission_params jsonb, target_amount integer, max_points integer
    )
    WHERE m.day_number IS NULL OR m.day_number NOT BETWEEN 1 AND 7
       OR m.slot IS NULL OR m.slot NOT BETWEEN 1 AND 5
       OR m.target_amount IS NULL OR m.target_amount NOT BETWEEN 1 AND 10000
       OR m.max_points IS NULL OR m.max_points <> CASE m.slot
         WHEN 1 THEN 300 WHEN 2 THEN 220 WHEN 3 THEN 190
         WHEN 4 THEN 160 WHEN 5 THEN 130 ELSE -1 END
       OR pg_catalog.jsonb_typeof(m.mission_params) IS DISTINCT FROM 'object'
       OR m.mission_type IS NULL
       OR (m.slot = 1 AND (
         m.mission_type <> 'daily_story' OR
         NULLIF(pg_catalog.btrim(m.story_id), '') IS NULL
       ))
       OR (m.slot > 1 AND (m.mission_type = 'daily_story' OR m.story_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'Invalid daily mission structure' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(DISTINCT (m.day_number, m.tier))
    INTO v_distinct_count
  FROM pg_catalog.jsonb_to_recordset(p_plan -> 'milestones') AS m(
    day_number integer, tier integer, required_points integer, coin_reward integer
  );

  IF v_distinct_count <> 35 OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_plan -> 'milestones') AS m(
      day_number integer, tier integer, required_points integer, coin_reward integer
    )
    WHERE m.day_number IS NULL OR m.day_number NOT BETWEEN 1 AND 7
       OR m.tier IS NULL OR m.tier NOT BETWEEN 1 AND 5
       OR m.required_points IS DISTINCT FROM m.tier * 200
       OR m.coin_reward IS DISTINCT FROM CASE m.tier
         WHEN 1 THEN 25 WHEN 2 THEN 50 WHEN 3 THEN 75
         WHEN 4 THEN 100 WHEN 5 THEN 150 ELSE -1 END
  ) THEN
    RAISE EXCEPTION 'Invalid daily milestone structure' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(DISTINCT m.story_id)
    INTO v_distinct_count
  FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
    day_number integer, slot integer, mission_type text, story_id text,
    mission_params jsonb, target_amount integer, max_points integer
  )
  WHERE m.slot = 1;

  IF v_distinct_count <> 7 OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
      day_number integer, slot integer, mission_type text, story_id text,
      mission_params jsonb, target_amount integer, max_points integer
    )
    WHERE m.slot = 1 AND m.story_id = v_featured_story
  ) THEN
    RAISE EXCEPTION 'Featured prize story must differ from all 7 daily stories' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*) INTO v_count
  FROM public.stories s
  JOIN (
    SELECT DISTINCT m.story_id
    FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
      day_number integer, slot integer, mission_type text, story_id text,
      mission_params jsonb, target_amount integer, max_points integer
    )
    WHERE m.slot = 1
  ) selected ON s.id::text = selected.story_id
  WHERE s.status = 'published'
    AND s.deleted_at IS NULL
    AND s.total_episodes >= 2
    AND COALESCE(s.is_adult, false) = false
    AND COALESCE(s.is_shadow_exclusive, false) = false
    AND COALESCE(s.admin_visibility_status, 'active') = 'active'
    AND pg_catalog.lower(COALESCE(s.access_type, 'free')) = 'free';

  IF v_count <> 7 THEN
    RAISE EXCEPTION 'One or more daily stories are not currently eligible' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shadow_read_event_weeks (
    starts_on, featured_story_id, audience_group, is_enabled
  ) VALUES (v_start, v_featured_story, 'kh', false)
  ON CONFLICT (starts_on) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT id, is_enabled INTO v_event_id, v_existing_enabled
    FROM public.shadow_read_event_weeks
    WHERE starts_on = v_start;

    IF v_event_id IS NULL THEN
      RAISE EXCEPTION 'Concurrent event creation not available; retry';
    END IF;

    SELECT pg_catalog.count(*) INTO v_count
    FROM public.shadow_read_event_missions
    WHERE event_id = v_event_id;
    IF v_count <> 35 THEN
      RAISE EXCEPTION 'Existing event has incomplete missions; review manually';
    END IF;

    SELECT pg_catalog.count(*) INTO v_count
    FROM public.shadow_read_event_milestones
    WHERE event_id = v_event_id;
    IF v_count <> 35 THEN
      RAISE EXCEPTION 'Existing event has incomplete milestones; review manually';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'created', false, 'event_id', v_event_id,
      'starts_on', v_start, 'is_enabled', v_existing_enabled
    );
  END IF;

  INSERT INTO public.shadow_read_event_missions (
    event_id, day_number, slot, mission_type, story_id,
    mission_params, target_amount, max_points
  )
  SELECT v_event_id, m.day_number, m.slot, m.mission_type, m.story_id,
         m.mission_params, m.target_amount, m.max_points
  FROM pg_catalog.jsonb_to_recordset(p_plan -> 'missions') AS m(
    day_number integer, slot integer, mission_type text, story_id text,
    mission_params jsonb, target_amount integer, max_points integer
  );

  INSERT INTO public.shadow_read_event_milestones (
    event_id, day_number, tier, required_points, coin_reward
  )
  SELECT v_event_id, m.day_number, m.tier, m.required_points, m.coin_reward
  FROM pg_catalog.jsonb_to_recordset(p_plan -> 'milestones') AS m(
    day_number integer, tier integer, required_points integer, coin_reward integer
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'created', true, 'event_id', v_event_id,
    'starts_on', v_start, 'is_enabled', false,
    'mission_count', 35, 'milestone_count', 35
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_save_plan(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_save_plan(jsonb)
  TO service_role;

COMMIT;
