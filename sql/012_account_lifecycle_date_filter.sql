BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE OR REPLACE FUNCTION public.shadow_deleted_accounts_list_v2(
    p_search text,
    p_page integer,
    p_status text,
    p_date_from date,
    p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
DECLARE
    v_search text := lower(btrim(coalesce(p_search, '')));
    v_page integer := coalesce(p_page, 1);
    v_status text := coalesce(p_status, 'all');
    v_from timestamptz;
    v_until timestamptz;
    v_result jsonb;
BEGIN
    IF v_page < 1 OR v_page > 100000 OR length(v_search) > 254 OR
       v_status NOT IN ('all', 'recoverable', 'expired_pending_purge', 'restored') THEN
        RAISE EXCEPTION 'Invalid deleted account list parameters';
    END IF;

    IF (p_date_from IS NOT NULL AND NOT isfinite(p_date_from)) OR
       (p_date_to IS NOT NULL AND NOT isfinite(p_date_to)) OR
       (p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to) THEN
        RAISE EXCEPTION 'Invalid deleted date range';
    END IF;

    v_from := p_date_from::timestamp AT TIME ZONE 'Asia/Phnom_Penh';
    v_until := (p_date_to + 1)::timestamp AT TIME ZONE 'Asia/Phnom_Penh';

    WITH filtered AS MATERIALIZED (
        SELECT d.id, d.user_id, d.requested_by, d.deleted_by, d.deleted_at,
               d.recover_until, d.restored_at, d.restored_by, d.status,
               u.username::text AS username, u.email::text AS email,
               u.created_at AS joined_at, u.is_author AS is_author
        FROM shadow_account_lifecycle.deleted_accounts d
        LEFT JOIN public.users u ON u.id = d.user_id
        WHERE (v_status = 'all' OR d.status = v_status)
          AND (v_from IS NULL OR d.deleted_at >= v_from)
          AND (v_until IS NULL OR d.deleted_at < v_until)
          AND (v_search = '' OR strpos(lower(d.user_id::text), v_search) > 0
               OR strpos(lower(coalesce(u.username::text, '')), v_search) > 0
               OR strpos(lower(coalesce(u.email::text, '')), v_search) > 0)
    ), paged AS (
        SELECT * FROM filtered
        ORDER BY deleted_at DESC, id DESC
        LIMIT 10 OFFSET ((v_page::bigint - 1) * 10)
    )
    SELECT jsonb_build_object(
        'page', v_page, 'page_size', 10,
        'total', (SELECT count(*) FROM filtered),
        'items', coalesce((
            SELECT jsonb_agg(
                to_jsonb(p) || jsonb_build_object(
                    'is_author', CASE
                        WHEN coalesce(p.is_author, false) OR EXISTS (
                            SELECT 1 FROM public.author_pages ap WHERE ap.user_id = p.user_id
                        ) THEN true ELSE p.is_author END
                ) ORDER BY p.deleted_at DESC, p.id DESC
            ) FROM paged p
        ), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_deleted_accounts_list_v2(text,integer,text,date,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shadow_deleted_accounts_list_v2(text,integer,text,date,date) TO service_role;

COMMIT;

SELECT
    to_regprocedure('public.shadow_deleted_accounts_list_v2(text,integer,text,date,date)') IS NOT NULL AS date_filter_ready,
    to_regprocedure('public.shadow_deleted_accounts_list(text,integer,text)') IS NOT NULL AS original_list_ready,
    has_function_privilege('service_role', 'public.shadow_deleted_accounts_list_v2(text,integer,text,date,date)', 'EXECUTE') AS service_access_ready,
    NOT has_function_privilege('anon', 'public.shadow_deleted_accounts_list_v2(text,integer,text,date,date)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.shadow_deleted_accounts_list_v2(text,integer,text,date,date)', 'EXECUTE') AS public_access_blocked;
