CREATE INDEX IF NOT EXISTS idx_comments_episode_visible_parent_count
ON public.comments (episode_id)
WHERE episode_id IS NOT NULL
  AND parent_id IS NULL
  AND deleted_at IS NULL
  AND is_hidden = false;

CREATE OR REPLACE FUNCTION public.get_episode_comment_totals(
  p_episode_ids uuid[]
)
RETURNS TABLE (
  episode_id uuid,
  total bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.episode_id,
    COUNT(*)::bigint AS total
  FROM public.comments c
  WHERE c.episode_id = ANY(
    COALESCE(
      p_episode_ids,
      ARRAY[]::uuid[]
    )
  )
    AND c.parent_id IS NULL
    AND c.deleted_at IS NULL
    AND c.is_hidden = false
  GROUP BY c.episode_id;
$$;

REVOKE ALL ON FUNCTION public.get_episode_comment_totals(
  uuid[]
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_episode_comment_totals(
  uuid[]
) TO service_role;
