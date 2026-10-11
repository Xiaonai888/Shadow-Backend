CREATE OR REPLACE FUNCTION public.get_reader_story_detail_status(
  p_story_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH matching_story AS (
    SELECT s.id, s.author_id, s.user_id
    FROM public.stories AS s
    WHERE s.id = p_story_id
      AND s.status = 'published'
      AND s.deleted_at IS NULL
  )
  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'story_found', true,
        'bookmarked', EXISTS (
          SELECT 1
          FROM public.reader_library AS rl
          WHERE rl.user_id = p_user_id
            AND rl.story_id = s.id
        ),
        'subscribed', EXISTS (
          SELECT 1
          FROM public.reader_subscriptions AS rs
          WHERE rs.user_id = p_user_id
            AND rs.story_id = s.id
        ),
        'author_state_loaded', ap.id IS NOT NULL,
        'author_following', EXISTS (
          SELECT 1
          FROM public.author_page_follows AS af
          WHERE af.author_page_id = s.author_id
            AND af.follower_user_id = p_user_id
        ),
        'author_follower_count', COALESCE(ap.total_followers, 0),
        'author_is_owner', COALESCE(
          COALESCE(ap.user_id, s.user_id) = p_user_id,
          false
        )
      )
      FROM matching_story AS s
      LEFT JOIN public.author_pages AS ap
        ON ap.id = s.author_id
        AND ap.status = 'active'
    ),
    jsonb_build_object('story_found', false)
  );
$$;

REVOKE ALL ON FUNCTION public.get_reader_story_detail_status(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_reader_story_detail_status(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_reader_story_detail_status(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_reader_story_detail_status(uuid, uuid) TO service_role;
