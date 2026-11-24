BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_deleted_accounts_list(
    p_search text DEFAULT '',
    p_page integer DEFAULT 1,
    p_status text DEFAULT 'all'
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
    v_result jsonb;
BEGIN
    IF v_page < 1 OR v_page > 100000 OR length(v_search) > 254 OR
       v_status NOT IN ('all', 'recoverable', 'expired_pending_purge', 'restored') THEN
        RAISE EXCEPTION 'Invalid deleted account list parameters';
    END IF;

    WITH filtered AS MATERIALIZED (
        SELECT d.id, d.user_id, d.requested_by, d.deleted_by, d.deleted_at,
               d.recover_until, d.restored_at, d.restored_by, d.status,
               u.username::text AS username, u.email::text AS email,
               u.created_at AS joined_at
        FROM shadow_account_lifecycle.deleted_accounts d
        LEFT JOIN public.users u ON u.id = d.user_id
        WHERE (v_status = 'all' OR d.status = v_status)
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
        'items', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.deleted_at DESC, p.id DESC) FROM paged p), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_deleted_account_details(p_record_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
    SELECT jsonb_build_object(
        'record', to_jsonb(d),
        'account', CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
            'user_id', u.id, 'username', u.username, 'email', u.email, 'joined_at', u.created_at
        ) END,
        'wallets', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'gem_balance', w.gem_balance,
                'diamond_balance', w.diamond_balance,
                'voucher_balance', w.voucher_balance,
                'vote_balance', w.vote_balance,
                'story_card_balance', w.story_card_balance
            )) FROM public.user_wallets w WHERE w.user_id = d.user_id
        ), '[]'::jsonb)
    )
    FROM shadow_account_lifecycle.deleted_accounts d
    LEFT JOIN public.users u ON u.id = d.user_id
    WHERE d.id = p_record_id;
$$;

REVOKE ALL ON FUNCTION public.shadow_deleted_accounts_list(text, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shadow_deleted_account_details(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shadow_deleted_accounts_list(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_deleted_account_details(bigint) TO service_role;

COMMIT;
