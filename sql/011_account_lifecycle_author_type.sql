BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $patch$
DECLARE
    v_list regprocedure := to_regprocedure('public.shadow_deleted_accounts_list(text,integer,text)');
    v_detail regprocedure := to_regprocedure('public.shadow_deleted_account_details(bigint)');
    v_proc regprocedure;
    v_definition text;
    v_original text;
    v_old text;
    v_new text;
    v_owner name;
    v_definer boolean;
    v_patch record;
BEGIN
    IF v_list IS NULL OR v_detail IS NULL OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'is_author' AND data_type = 'boolean'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'author_pages'
          AND column_name = 'user_id' AND udt_name = 'uuid'
    ) THEN
        RAISE EXCEPTION 'Required lifecycle functions or author columns are missing';
    END IF;

    FOR v_proc IN SELECT unnest(ARRAY[v_list, v_detail]) LOOP
        SELECT pg_get_userbyid(proowner), prosecdef
        INTO v_owner, v_definer
        FROM pg_proc WHERE oid = v_proc;

        IF v_owner <> current_user OR NOT v_definer THEN
            RAISE EXCEPTION 'Unexpected lifecycle function owner or security mode';
        END IF;

        v_original := pg_get_functiondef(v_proc);
        v_definition := v_original;

        FOR v_patch IN
            SELECT * FROM (VALUES
                (v_list,
                 'u.created_at AS joined_at',
                 'u.created_at AS joined_at, u.is_author AS is_author'),
                (v_list,
                 'jsonb_agg(to_jsonb(p) ORDER BY p.deleted_at DESC, p.id DESC)',
                 'jsonb_agg(to_jsonb(p) || jsonb_build_object(''is_author'', CASE WHEN coalesce(p.is_author, false) OR EXISTS (SELECT 1 FROM public.author_pages ap WHERE ap.user_id = p.user_id) THEN true ELSE p.is_author END) ORDER BY p.deleted_at DESC, p.id DESC)'),
                (v_detail,
                 '''joined_at'', u.created_at',
                 '''joined_at'', u.created_at, ''is_author'', (coalesce(u.is_author, false) OR EXISTS (SELECT 1 FROM public.author_pages ap WHERE ap.user_id = u.id))')
            ) AS patches(proc, old_text, new_text)
            WHERE proc = v_proc
        LOOP
            v_old := v_patch.old_text;
            v_new := v_patch.new_text;
            IF strpos(v_definition, v_new) > 0 THEN
                CONTINUE;
            END IF;
            IF (length(v_definition) - length(replace(v_definition, v_old, ''))) <> length(v_old) THEN
                RAISE EXCEPTION 'Live lifecycle RPC differs from expected code: %. No changes applied.', v_proc;
            END IF;
            v_definition := replace(v_definition, v_old, v_new);
        END LOOP;

        IF v_definition <> v_original THEN
            EXECUTE v_definition;
        END IF;
    END LOOP;
END;
$patch$;

COMMIT;

SELECT
    strpos(pg_get_functiondef('public.shadow_deleted_accounts_list(text,integer,text)'::regprocedure),
        'public.author_pages ap WHERE ap.user_id = p.user_id') > 0 AS list_author_ready,
    strpos(pg_get_functiondef('public.shadow_deleted_account_details(bigint)'::regprocedure),
        'public.author_pages ap WHERE ap.user_id = u.id') > 0 AS details_author_ready;
