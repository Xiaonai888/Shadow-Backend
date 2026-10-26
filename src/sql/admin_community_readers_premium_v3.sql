CREATE OR REPLACE FUNCTION public.get_admin_community_readers_v3(
  p_page integer DEFAULT 1,
  p_limit integer DEFAULT 10,
  p_search text DEFAULT '',
  p_filter text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH source AS (
    SELECT public.get_admin_community_readers_v2(
      p_page,
      p_limit,
      p_search,
      p_filter
    ) AS payload
  )
  SELECT jsonb_set(
    source.payload,
    '{readers}',
    COALESCE(
      (
        SELECT jsonb_agg(
          row_data.reader || jsonb_build_object(
            'is_premium',
            COALESCE(account.is_premium, false)
            AND COALESCE(account.premium_expires_at > now(), false)
          )
          ORDER BY row_data.position
        )
        FROM jsonb_array_elements(
          COALESCE(source.payload -> 'readers', '[]'::jsonb)
        ) WITH ORDINALITY AS row_data(reader, position)
        LEFT JOIN public.users AS account
          ON account.id = NULLIF(row_data.reader ->> 'id', '')::uuid
      ),
      '[]'::jsonb
    ),
    true
  )
  FROM source;
$$;

REVOKE ALL ON FUNCTION public.get_admin_community_readers_v3(integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_community_readers_v3(integer, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_admin_community_readers_v3(integer, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_community_readers_v3(integer, integer, text, text) TO service_role;

SELECT jsonb_pretty(
  public.get_admin_community_readers_v3(1, 10, 'snowy__23', 'all')
) AS premium_reader_test;
