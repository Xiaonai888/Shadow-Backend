CREATE OR REPLACE FUNCTION public.get_episode_hot_comment_summary(p_episode_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
WITH episode_info AS (
  SELECT e.id AS episode_id, e.story_id, s.user_id AS story_owner_user_id
  FROM public.episodes e
  JOIN public.stories s ON s.id = e.story_id
  WHERE e.id = p_episode_id
),
parent_candidates AS (
  SELECT
    c.id,
    c.story_id,
    c.episode_id,
    c.user_id,
    c.text,
    c.likes,
    c.is_pinned,
    c.created_at,
    ei.story_owner_user_id
  FROM public.comments c
  JOIN episode_info ei ON ei.episode_id = c.episode_id AND ei.story_id = c.story_id
  WHERE c.is_hidden = false
    AND c.deleted_at IS NULL
    AND c.parent_id IS NULL
  ORDER BY c.is_pinned DESC, c.likes DESC, c.created_at DESC
  LIMIT 20
),
ranked_candidates AS (
  SELECT
    p.*,
    LEAST(
      5::bigint,
      (
        SELECT COUNT(*)
        FROM public.comments r
        WHERE r.parent_id = p.id
          AND r.story_id = p.story_id
          AND r.episode_id = p.episode_id
          AND r.is_hidden = false
          AND r.deleted_at IS NULL
      )
    ) AS reply_count
  FROM parent_candidates p
),
hot_comment AS (
  SELECT *
  FROM ranked_candidates
  ORDER BY reply_count DESC, likes DESC, is_pinned DESC, created_at DESC
  LIMIT 1
)
SELECT jsonb_build_object(
  'episode_found', EXISTS (SELECT 1 FROM episode_info),
  'total', (
    SELECT COUNT(*)
    FROM public.comments c
    JOIN episode_info ei ON ei.episode_id = c.episode_id AND ei.story_id = c.story_id
    WHERE c.is_hidden = false
      AND c.deleted_at IS NULL
      AND c.parent_id IS NULL
  ),
  'hot_comment', (
    SELECT jsonb_build_object(
      'id', c.id,
      'story_id', c.story_id,
      'episode_id', c.episode_id,
      'user_id', c.user_id,
      'text', c.text,
      'likes', COALESCE(c.likes, 0),
      'reply_count', c.reply_count,
      'created_at', c.created_at,
      'is_author_comment', c.user_id = c.story_owner_user_id,
      'actor_type', CASE WHEN c.user_id = c.story_owner_user_id THEN 'author' ELSE 'reader' END,
      'profile_type', CASE WHEN c.user_id = c.story_owner_user_id THEN 'author' ELSE 'reader' END,
      'user', jsonb_build_object(
        'id', u.id,
        'name', CASE
          WHEN c.user_id = c.story_owner_user_id
            THEN COALESCE(NULLIF(ap.page_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), 'Reader')
          ELSE COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), 'Reader')
        END,
        'username', CASE
          WHEN c.user_id = c.story_owner_user_id
            THEN COALESCE(NULLIF(ap.page_username, ''), NULLIF(u.username, ''), '')
          ELSE COALESCE(NULLIF(u.username, ''), '')
        END,
        'avatar_url', CASE
          WHEN c.user_id = c.story_owner_user_id
            THEN COALESCE(NULLIF(ap.avatar_url, ''), NULLIF(u.avatar_url, ''), '')
          ELSE COALESCE(NULLIF(u.avatar_url, ''), '')
        END,
        'role', CASE
          WHEN c.user_id = c.story_owner_user_id THEN 'author'
          ELSE COALESCE(NULLIF(u.role, ''), 'reader')
        END,
        'profile_type', CASE WHEN c.user_id = c.story_owner_user_id THEN 'author' ELSE 'reader' END,
        'author_page_id', CASE WHEN c.user_id = c.story_owner_user_id THEN ap.id ELSE NULL END,
        'author_page_username', CASE WHEN c.user_id = c.story_owner_user_id THEN COALESCE(ap.page_username, '') ELSE '' END
      )
    )
    FROM hot_comment c
    LEFT JOIN public.users u ON u.id = c.user_id
    LEFT JOIN public.author_pages ap ON ap.user_id = c.story_owner_user_id
  )
);
$$;

REVOKE ALL ON FUNCTION public.get_episode_hot_comment_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_episode_hot_comment_summary(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_episode_hot_comment_summary(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_episode_hot_comment_summary(uuid) TO service_role;
