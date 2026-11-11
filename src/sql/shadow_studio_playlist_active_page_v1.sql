CREATE OR REPLACE FUNCTION public.shadow_studio_playlist_active_page(
  p_owner uuid,
  p_playlist uuid,
  p_limit integer DEFAULT 12,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_owner IS NULL OR p_playlist IS NULL OR p_limit IS NULL OR p_offset IS NULL
    OR p_limit < 1 OR p_limit > 24 OR p_offset < 0 OR p_offset > 5000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PARAMS');
  END IF;

  WITH owned AS (
    SELECT id, name, is_public, created_at, updated_at
    FROM public.fast_reel_playlists
    WHERE id = p_playlist AND user_id = p_owner
  ), active AS MATERIALIZED (
    SELECT
      v.id, v.user_id, v.video_url, v.thumbnail_url, v.title,
      v.description, v.tags, v.status, v.access_type,
      v.unlock_price_diamonds, v.published_at, v.view_count,
      v.video_type, v.duration_seconds
    FROM public.fast_reel_playlist_items i
    JOIN owned p ON p.id = i.playlist_id
    JOIN public.fast_videos v ON v.id = i.video_id
    WHERE v.user_id = p_owner AND v.studio_state = 'active'
  ), page_rows AS (
    SELECT * FROM active
    ORDER BY published_at DESC NULLS LAST, id DESC
    LIMIT p_limit OFFSET p_offset
  ), statistics AS (
    SELECT count(*) AS total FROM active
  ), page_data AS (
    SELECT
      count(*) AS page_size,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', id,
            'user_id', user_id,
            'video_url', video_url,
            'thumbnail_url', thumbnail_url,
            'title', title,
            'description', description,
            'tags', tags,
            'status', status,
            'access_type', access_type,
            'unlock_price_diamonds', unlock_price_diamonds,
            'published_at', published_at,
            'view_count', view_count,
            'video_type', video_type,
            'duration_seconds', duration_seconds
          ) ORDER BY published_at DESC NULLS LAST, id DESC
        ),
        '[]'::jsonb
      ) AS videos
    FROM page_rows
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM owned) THEN
      jsonb_build_object('ok', false, 'code', 'NOT_FOUND')
    ELSE
      jsonb_build_object(
        'ok', true,
        'playlist', (
          SELECT jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'is_public', p.is_public,
            'created_at', p.created_at,
            'updated_at', p.updated_at,
            'video_count', statistics.total,
            'thumbnail_url', (
              SELECT nullif(a.thumbnail_url, '')
              FROM active a
              ORDER BY a.published_at DESC NULLS LAST, a.id DESC
              LIMIT 1
            )
          )
          FROM owned p
        ),
        'videos', page_data.videos,
        'pagination', jsonb_build_object(
          'limit', p_limit,
          'offset', p_offset,
          'next_offset', p_offset + page_data.page_size,
          'has_more', p_offset + page_data.page_size < statistics.total,
          'total', statistics.total
        )
      )
  END
  INTO v_result
  FROM statistics CROSS JOIN page_data;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_studio_playlist_active_page(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_studio_playlist_active_page(uuid, uuid, integer, integer)
  TO service_role;
NOTIFY pgrst, 'reload schema';
