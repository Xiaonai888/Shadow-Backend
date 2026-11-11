CREATE OR REPLACE FUNCTION public.shadow_studio_playlist_summaries(
  p_owner uuid,
  p_ids uuid[]
)
RETURNS TABLE (
  playlist_id uuid,
  video_count bigint,
  thumbnail_url text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH owned AS (
    SELECT p.id
    FROM public.fast_reel_playlists p
    WHERE p.user_id = p_owner
      AND p.id = ANY (p_ids)
  ), counts AS (
    SELECT i.playlist_id, COUNT(v.id)::bigint AS video_count
    FROM public.fast_reel_playlist_items i
    JOIN owned o ON o.id = i.playlist_id
    JOIN public.fast_videos v
      ON v.id = i.video_id
      AND v.user_id = p_owner
      AND v.studio_state = 'active'
    GROUP BY i.playlist_id
  )
  SELECT o.id,
         COALESCE(c.video_count, 0::bigint),
         preview.thumbnail_url
  FROM owned o
  LEFT JOIN counts c ON c.playlist_id = o.id
  LEFT JOIN LATERAL (
    SELECT NULLIF(v.thumbnail_url, '')::text AS thumbnail_url
    FROM public.fast_reel_playlist_items i
    JOIN public.fast_videos v
      ON v.id = i.video_id
      AND v.user_id = p_owner
      AND v.studio_state = 'active'
    WHERE i.playlist_id = o.id
    ORDER BY v.published_at DESC NULLS LAST, v.id DESC
    LIMIT 1
  ) preview ON TRUE;
$$;

REVOKE ALL ON FUNCTION public.shadow_studio_playlist_summaries(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_studio_playlist_summaries(uuid, uuid[]) TO service_role;
