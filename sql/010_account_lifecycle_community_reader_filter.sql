BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $patch$
DECLARE
    v_proc regprocedure := to_regprocedure('public.get_admin_community_readers_v2(integer,integer,text,text)');
    v_definition text;
    v_anchor text := E'  left join public.reader_presence rp\n    on rp.user_id = u.id\n),\nfiltered as (';
    v_replacement text := E'  left join public.reader_presence rp\n    on rp.user_id = u.id\n  where not exists (\n    select 1\n    from shadow_account_lifecycle.deletion_records d\n    where d.user_id = u.id and d.restored_at is null\n  )\n),\nfiltered as (';
    v_v3 regprocedure := to_regprocedure('public.get_admin_community_readers_v3(integer,integer,text,text)');
    v_owner name;
    v_security_definer boolean;
    v_target uuid;
    v_payload jsonb;
BEGIN
    IF v_proc IS NULL OR to_regclass('shadow_account_lifecycle.deletion_records') IS NULL THEN
        RAISE EXCEPTION 'Required reader RPC or lifecycle table is missing';
    END IF;

    IF v_v3 IS NULL OR strpos(pg_get_functiondef(v_v3), 'public.get_admin_community_readers_v2(') = 0 THEN
        RAISE EXCEPTION 'Premium reader RPC no longer delegates to v2';
    END IF;

    SELECT pg_get_userbyid(proowner), prosecdef
    INTO v_owner, v_security_definer
    FROM pg_proc WHERE oid = v_proc;

    IF NOT v_security_definer OR v_owner <> current_user THEN
        RAISE EXCEPTION 'Unexpected RPC owner or security mode; inspect function before patching';
    END IF;

    IF NOT has_schema_privilege(v_owner, 'shadow_account_lifecycle', 'USAGE')
       OR NOT has_table_privilege(v_owner, 'shadow_account_lifecycle.deletion_records', 'SELECT') THEN
        RAISE EXCEPTION 'RPC owner cannot read lifecycle records';
    END IF;

    IF row_security_active('shadow_account_lifecycle.deletion_records'::regclass) THEN
        RAISE EXCEPTION 'Lifecycle row visibility must be verified first';
    END IF;

    v_definition := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    IF strpos(v_definition, v_replacement) = 0 THEN
        IF (length(v_definition) - length(replace(v_definition, v_anchor, ''))) <> length(v_anchor) THEN
            RAISE EXCEPTION 'Live reader RPC differs from the inspected version; no changes applied';
        END IF;
        EXECUTE replace(v_definition, v_anchor, v_replacement);
    END IF;

    SELECT d.user_id INTO v_target
    FROM shadow_account_lifecycle.deletion_records d
    WHERE d.restored_at IS NULL
    ORDER BY d.deleted_at DESC
    LIMIT 1;

    IF v_target IS NOT NULL THEN
        v_payload := public.get_admin_community_readers_v3(1, 10, v_target::text, 'all');
        IF v_payload IS NULL OR (v_payload ->> 'ok') IS DISTINCT FROM 'true'
           OR (v_payload ->> 'total') IS DISTINCT FROM '0'
           OR (v_payload -> 'readers') IS DISTINCT FROM '[]'::jsonb THEN
            RAISE EXCEPTION 'Deleted account exclusion verification failed';
        END IF;
    END IF;
END;
$patch$;

COMMIT;

SELECT
    strpos(pg_get_functiondef(to_regprocedure('public.get_admin_community_readers_v2(integer,integer,text,text)')),
        'from shadow_account_lifecycle.deletion_records d') > 0 AS reader_filter_ready,
    strpos(pg_get_functiondef(to_regprocedure('public.get_admin_community_readers_v3(integer,integer,text,text)')),
        'get_admin_community_readers_v2') > 0 AS premium_rpc_linked;
