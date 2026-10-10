CREATE TABLE IF NOT EXISTS public.discover_special_promotion_rotation (
  id smallint PRIMARY KEY CHECK (id = 1),
  slot_start_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  expires_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  promotions jsonb NOT NULL DEFAULT '[]'::jsonb,
  used_story_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_story_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  rotation_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.discover_special_promotion_rotation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discover_special_promotion_rotation FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.discover_special_promotion_rotation TO service_role;

CREATE INDEX IF NOT EXISTS idx_special_promotion_episode_lookup
  ON public.episodes (story_id, first_published_at, episode_number, created_at)
  WHERE status = 'published' AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.get_or_rotate_discover_special_promotions_v2()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_slot_start timestamptz;
  v_expires_at timestamptz;
  v_state public.discover_special_promotion_rotation%ROWTYPE;
  v_candidates jsonb := '[]'::jsonb;
  v_promotions jsonb := '[]'::jsonb;
  v_choice jsonb;
  v_used_ids text[] := ARRAY[]::text[];
  v_selected_ids text[] := ARRAY[]::text[];
  v_previous_ids text[] := ARRAY[]::text[];
  v_total integer := 0;
  v_position integer;
  v_rate numeric;
  v_original numeric;
  v_discounted numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(26577, 603);

  v_slot_start := to_timestamp(
    floor((extract(epoch FROM v_now) + 25200) / 21600) * 21600 - 25200
  );
  v_expires_at := v_slot_start + interval '6 hours';

  INSERT INTO public.discover_special_promotion_rotation (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.discover_special_promotion_rotation
  WHERE id = 1
  FOR UPDATE;

  IF v_state.slot_start_at = v_slot_start THEN
    RETURN jsonb_build_object(
      'promotions', v_state.promotions,
      'promotion', v_state.promotions -> 0,
      'expires_at', v_state.expires_at,
      'slot_start_at', v_state.slot_start_at,
      'rotation_key', extract(epoch FROM v_slot_start)::bigint
    );
  END IF;

  SELECT diamond_per_episode INTO v_rate
  FROM public.platform_unlock_rules
  WHERE id = 1;

  v_rate := coalesce(v_rate, 10);

  IF v_rate < 2 OR v_rate <> trunc(v_rate) THEN
    RAISE EXCEPTION 'INVALID_DIAMOND_PRICE';
  END IF;

  WITH published AS (
    SELECT
      s.id::text AS story_id,
      s.title AS story_title,
      coalesce(s.description, '') AS description,
      s.cover_url,
      e.is_locked,
      e.is_free_published,
      row_number() OVER (
        PARTITION BY s.id
        ORDER BY
          coalesce(e.first_published_at, to_timestamp(0)),
          e.episode_number,
          e.created_at,
          e.id
      ) AS published_rank
    FROM public.stories AS s
    JOIN public.author_pages AS a
      ON a.id = s.author_id
    JOIN public.episodes AS e
      ON e.story_id = s.id
    WHERE s.status = 'published'
      AND s.deleted_at IS NULL
      AND coalesce(s.total_episodes, 0) >= 10
      AND (s.admin_visibility_status IS NULL OR s.admin_visibility_status = 'active')
      AND coalesce(s.is_adult, false) = false
      AND coalesce(s.is_shadow_exclusive, false) = false
      AND a.status = 'active'
      AND (a.admin_status IS NULL OR a.admin_status = 'active')
      AND s.title IS NOT NULL
      AND s.cover_url IS NOT NULL
      AND s.cover_url <> ''
      AND e.status = 'published'
      AND e.deleted_at IS NULL
      AND (e.first_published_at IS NULL OR e.first_published_at <= v_now)
  ), totals AS (
    SELECT
      story_id,
      story_title,
      description,
      cover_url,
      count(*)::integer AS total_episodes,
      count(*) FILTER (
        WHERE coalesce(is_locked, false)
          AND NOT coalesce(is_free_published, false)
          AND published_rank > 5
      )::integer AS locked_episode_count
    FROM published
    GROUP BY story_id, story_title, description, cover_url
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'story_id', story_id,
        'story_title', story_title,
        'description', description,
        'cover_url', cover_url,
        'profile_image_url', cover_url,
        'locked_episode_count', locked_episode_count,
        'total_episodes', total_episodes
      )
    ),
    '[]'::jsonb
  ) INTO v_candidates
  FROM totals
  WHERE locked_episode_count >= 5;

  v_total := jsonb_array_length(v_candidates);
  v_used_ids := coalesce(v_state.used_story_ids, ARRAY[]::text[]);
  v_previous_ids := coalesce(v_state.last_story_ids, ARRAY[]::text[]);

  FOR v_position IN 1..least(3, v_total) LOOP
    v_choice := NULL;

    SELECT candidate.value INTO v_choice
    FROM jsonb_array_elements(v_candidates) AS candidate(value)
    WHERE NOT ((candidate.value->>'story_id') = ANY(v_used_ids))
      AND NOT ((candidate.value->>'story_id') = ANY(v_selected_ids))
    ORDER BY
      CASE WHEN v_state.rotation_count = 0 AND v_position = 1
        THEN (candidate.value->>'locked_episode_count')::integer
      END DESC NULLS LAST,
      CASE WHEN v_state.rotation_count = 0 AND v_position > 1
        THEN (candidate.value->>'locked_episode_count')::integer
      END ASC NULLS LAST,
      md5((candidate.value->>'story_id') || v_slot_start::text || v_position::text)
    LIMIT 1;

    IF v_choice IS NULL THEN
      v_used_ids := v_selected_ids;

      SELECT candidate.value INTO v_choice
      FROM jsonb_array_elements(v_candidates) AS candidate(value)
      WHERE NOT ((candidate.value->>'story_id') = ANY(v_selected_ids))
      ORDER BY
        CASE
          WHEN v_total > 3 AND (candidate.value->>'story_id') = ANY(v_previous_ids) THEN 1
          ELSE 0
        END,
        md5((candidate.value->>'story_id') || v_slot_start::text || v_position::text)
      LIMIT 1;
    END IF;

    EXIT WHEN v_choice IS NULL;

    v_selected_ids := array_append(v_selected_ids, v_choice->>'story_id');
    v_used_ids := array_append(v_used_ids, v_choice->>'story_id');
    v_original := (v_choice->>'locked_episode_count')::integer * v_rate;
    v_discounted := ceil(v_original / 2);

    v_promotions := v_promotions || jsonb_build_array(
      v_choice || jsonb_build_object(
        'id', 'special-' || (v_choice->>'story_id'),
        'original_price_diamonds', v_original::integer,
        'discounted_price_diamonds', v_discounted::integer,
        'discount_percent', 50,
        'slot_start_at', v_slot_start,
        'expires_at', v_expires_at
      )
    );
  END LOOP;

  UPDATE public.discover_special_promotion_rotation
  SET
    slot_start_at = v_slot_start,
    expires_at = v_expires_at,
    promotions = v_promotions,
    used_story_ids = v_used_ids,
    last_story_ids = v_selected_ids,
    rotation_count = v_state.rotation_count + 1,
    updated_at = v_now
  WHERE id = 1;

  RETURN jsonb_build_object(
    'promotions', v_promotions,
    'promotion', v_promotions -> 0,
    'expires_at', v_expires_at,
    'slot_start_at', v_slot_start,
    'rotation_key', extract(epoch FROM v_slot_start)::bigint
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_rotate_discover_special_promotions_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_rotate_discover_special_promotions_v2() TO service_role;
