CREATE TABLE IF NOT EXISTS public.admin_reader_country_analytics_snapshot (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO public.admin_reader_country_analytics_snapshot (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.admin_reader_country_analytics_snapshot ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_reader_country_analytics_snapshot FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_reader_country_analytics_snapshot TO service_role;

CREATE OR REPLACE FUNCTION public.get_admin_reader_country_analytics(
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := NOW();
  v_payload jsonb;
  v_generated_at timestamptz;
  v_should_refresh boolean;
  v_total_readers bigint := 0;
  v_readers_with_country bigint := 0;
  v_unknown_country bigint := 0;
  v_countries_reached bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_top_country jsonb;
  v_source_updated_at timestamptz;
BEGIN
  SELECT payload, generated_at
  INTO v_payload, v_generated_at
  FROM public.admin_reader_country_analytics_snapshot
  WHERE id = 1;

  v_should_refresh :=
    v_generated_at IS NULL
    OR v_payload IS NULL
    OR v_payload = '{}'::jsonb
    OR v_generated_at <= v_now - INTERVAL '12 hours'
    OR (
      COALESCE(p_force, false)
      AND v_generated_at <= v_now - INTERVAL '10 minutes'
    );

  IF NOT v_should_refresh THEN
    RETURN jsonb_build_object(
      'data', v_payload,
      'meta', jsonb_build_object(
        'refreshed', false,
        'refresh_reason', CASE WHEN COALESCE(p_force, false) THEN 'manual_cooldown' ELSE 'fresh_cache' END,
        'checked_at', v_now,
        'generated_at', v_generated_at,
        'next_auto_refresh_at', v_generated_at + INTERVAL '12 hours',
        'manual_refresh_available_at', v_generated_at + INTERVAL '10 minutes'
      )
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin_reader_country_analytics'));

  SELECT payload, generated_at
  INTO v_payload, v_generated_at
  FROM public.admin_reader_country_analytics_snapshot
  WHERE id = 1;

  v_should_refresh :=
    v_generated_at IS NULL
    OR v_payload IS NULL
    OR v_payload = '{}'::jsonb
    OR v_generated_at <= v_now - INTERVAL '12 hours'
    OR (
      COALESCE(p_force, false)
      AND v_generated_at <= v_now - INTERVAL '10 minutes'
    );

  IF NOT v_should_refresh THEN
    RETURN jsonb_build_object(
      'data', v_payload,
      'meta', jsonb_build_object(
        'refreshed', false,
        'refresh_reason', 'refreshed_by_another_request',
        'checked_at', v_now,
        'generated_at', v_generated_at,
        'next_auto_refresh_at', v_generated_at + INTERVAL '12 hours',
        'manual_refresh_available_at', v_generated_at + INTERVAL '10 minutes'
      )
    );
  END IF;

  WITH reader_base AS (
    SELECT
      u.id,
      NULLIF(UPPER(TRIM(rp.last_country_code)), '') AS country_code,
      COALESCE(
        NULLIF(TRIM(rp.last_country_name), ''),
        NULLIF(UPPER(TRIM(rp.last_country_code)), '')
      ) AS country_name,
      rp.last_seen_at,
      rp.last_activity_at
    FROM public.users u
    LEFT JOIN public.reader_presence rp
      ON rp.user_id = u.id
  ),
  totals AS (
    SELECT
      COUNT(*) AS total_readers,
      COUNT(*) FILTER (WHERE country_code IS NOT NULL) AS readers_with_country,
      COUNT(DISTINCT country_code) FILTER (WHERE country_code IS NOT NULL) AS countries_reached
    FROM reader_base
  ),
  country_stats AS (
    SELECT
      country_code,
      COALESCE(MAX(country_name), country_code) AS country_name,
      COUNT(*) AS total_readers,
      COUNT(*) FILTER (
        WHERE last_seen_at >= v_now - INTERVAL '10 minutes'
      ) AS online_at_snapshot,
      COUNT(*) FILTER (
        WHERE last_activity_at >= v_now - INTERVAL '7 days'
      ) AS active_recently,
      COUNT(*) FILTER (
        WHERE last_activity_at < v_now - INTERVAL '7 days'
          AND last_activity_at >= v_now - INTERVAL '30 days'
      ) AS inactive_8_30_days,
      COUNT(*) FILTER (
        WHERE last_activity_at < v_now - INTERVAL '30 days'
      ) AS dormant_30_plus_days,
      COUNT(*) FILTER (
        WHERE last_activity_at IS NULL
      ) AS no_activity_data
    FROM reader_base
    WHERE country_code IS NOT NULL
    GROUP BY country_code
  ),
  country_rows AS (
    SELECT
      cs.*,
      ROUND(
        cs.total_readers::numeric * 100
        / NULLIF(t.total_readers, 0),
        2
      ) AS percentage_of_all_readers,
      ROUND(
        cs.total_readers::numeric * 100
        / NULLIF(t.readers_with_country, 0),
        2
      ) AS percentage_of_known_readers
    FROM country_stats cs
    CROSS JOIN totals t
  )
  SELECT
    t.total_readers,
    t.readers_with_country,
    t.total_readers - t.readers_with_country,
    t.countries_reached,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'country_code', cr.country_code,
            'country_name', cr.country_name,
            'total_readers', cr.total_readers,
            'online_at_snapshot', cr.online_at_snapshot,
            'active_recently', cr.active_recently,
            'inactive_8_30_days', cr.inactive_8_30_days,
            'dormant_30_plus_days', cr.dormant_30_plus_days,
            'no_activity_data', cr.no_activity_data,
            'percentage_of_all_readers', cr.percentage_of_all_readers,
            'percentage_of_known_readers', cr.percentage_of_known_readers
          )
          ORDER BY cr.total_readers DESC, cr.country_code ASC
        )
        FROM country_rows cr
      ),
      '[]'::jsonb
    ),
    (
      SELECT jsonb_build_object(
        'country_code', cr.country_code,
        'country_name', cr.country_name,
        'total_readers', cr.total_readers,
        'percentage_of_all_readers', cr.percentage_of_all_readers,
        'percentage_of_known_readers', cr.percentage_of_known_readers
      )
      FROM country_rows cr
      ORDER BY cr.total_readers DESC, cr.country_code ASC
      LIMIT 1
    )
  INTO
    v_total_readers,
    v_readers_with_country,
    v_unknown_country,
    v_countries_reached,
    v_rows,
    v_top_country
  FROM totals t;

  SELECT NULLIF(
    GREATEST(
      COALESCE((SELECT MAX(created_at) FROM public.users), '-infinity'::timestamptz),
      COALESCE((SELECT MAX(updated_at) FROM public.reader_presence), '-infinity'::timestamptz),
      COALESCE((SELECT MAX(country_last_seen_at) FROM public.reader_presence), '-infinity'::timestamptz)
    ),
    '-infinity'::timestamptz
  )
  INTO v_source_updated_at;

  v_payload := jsonb_build_object(
    'generated_at', v_now,
    'source_updated_at', v_source_updated_at,
    'refresh_window_hours', 12,
    'manual_refresh_cooldown_minutes', 10,
    'totals', jsonb_build_object(
      'total_readers', v_total_readers,
      'countries_reached', v_countries_reached,
      'readers_with_country', v_readers_with_country,
      'unknown_country', v_unknown_country,
      'top_country', v_top_country
    ),
    'rows', v_rows
  );

  UPDATE public.admin_reader_country_analytics_snapshot
  SET
    payload = v_payload,
    generated_at = v_now,
    updated_at = v_now
  WHERE id = 1;

  RETURN jsonb_build_object(
    'data', v_payload,
    'meta', jsonb_build_object(
      'refreshed', true,
      'refresh_reason', CASE WHEN COALESCE(p_force, false) THEN 'manual_refresh' ELSE 'stale_or_missing_snapshot' END,
      'checked_at', v_now,
      'generated_at', v_now,
      'next_auto_refresh_at', v_now + INTERVAL '12 hours',
      'manual_refresh_available_at', v_now + INTERVAL '10 minutes'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_reader_country_analytics(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_reader_country_analytics(boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.get_admin_reader_country_readers(
  p_country_code text,
  p_page integer DEFAULT 1,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := NOW();
  v_code text := UPPER(TRIM(COALESCE(p_country_code, '')));
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 50);
  v_offset integer;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_code <> 'UNKNOWN' AND v_code !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Invalid country code';
  END IF;

  v_offset := (v_page - 1) * v_limit;

  SELECT COUNT(*)
  INTO v_total
  FROM public.users u
  LEFT JOIN public.reader_presence rp
    ON rp.user_id = u.id
  WHERE
    CASE
      WHEN v_code = 'UNKNOWN'
      THEN NULLIF(TRIM(rp.last_country_code), '') IS NULL
      ELSE UPPER(NULLIF(TRIM(rp.last_country_code), '')) = v_code
    END;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'name', q.name,
        'username', q.username,
        'email', q.email,
        'avatar_url', q.avatar_url,
        'is_author', q.is_author,
        'status', q.status,
        'joined_at', q.joined_at,
        'country_code', q.country_code,
        'country_name', q.country_name,
        'last_seen_at', q.last_seen_at,
        'last_activity_at', q.last_activity_at,
        'presence_status', q.presence_status,
        'activity_status', q.activity_status
      )
      ORDER BY q.last_activity_at DESC NULLS LAST, q.joined_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT
      u.id,
      COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), 'Reader') AS name,
      COALESCE(u.username, '') AS username,
      COALESCE(u.email, '') AS email,
      COALESCE(u.avatar_url, '') AS avatar_url,
      COALESCE(u.is_author, false) AS is_author,
      CASE WHEN u.is_active = false THEN 'inactive' ELSE 'active' END AS status,
      u.created_at AS joined_at,
      NULLIF(UPPER(TRIM(rp.last_country_code)), '') AS country_code,
      COALESCE(
        NULLIF(TRIM(rp.last_country_name), ''),
        NULLIF(UPPER(TRIM(rp.last_country_code)), '')
      ) AS country_name,
      rp.last_seen_at,
      rp.last_activity_at,
      CASE
        WHEN rp.last_seen_at >= v_now - INTERVAL '10 minutes'
          AND COALESCE(rp.visibility_state, 'visible') = 'visible'
        THEN 'online'
        WHEN rp.last_seen_at >= v_now - INTERVAL '10 minutes'
        THEN 'idle'
        ELSE 'offline'
      END AS presence_status,
      CASE
        WHEN rp.last_activity_at IS NULL THEN 'no_activity_data'
        WHEN rp.last_activity_at >= v_now - INTERVAL '7 days' THEN 'active_recently'
        WHEN rp.last_activity_at >= v_now - INTERVAL '30 days' THEN 'inactive'
        ELSE 'dormant'
      END AS activity_status
    FROM public.users u
    LEFT JOIN public.reader_presence rp
      ON rp.user_id = u.id
    WHERE
      CASE
        WHEN v_code = 'UNKNOWN'
        THEN NULLIF(TRIM(rp.last_country_code), '') IS NULL
        ELSE UPPER(NULLIF(TRIM(rp.last_country_code), '')) = v_code
      END
    ORDER BY rp.last_activity_at DESC NULLS LAST, u.created_at DESC
    LIMIT v_limit
    OFFSET v_offset
  ) q;

  RETURN jsonb_build_object(
    'country_code', v_code,
    'page', v_page,
    'limit', v_limit,
    'total', v_total,
    'total_pages', CASE
      WHEN v_total = 0 THEN 0
      ELSE CEIL(v_total::numeric / v_limit)::integer
    END,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_reader_country_readers(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_reader_country_readers(text, integer, integer) TO service_role;
