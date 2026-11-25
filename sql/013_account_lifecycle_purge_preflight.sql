WITH RECURSIVE dependencies(relid) AS (
    SELECT oid FROM pg_class
    WHERE oid IN (to_regclass('public.users'), to_regclass('auth.users'))
    UNION
    SELECT f.conrelid FROM pg_constraint f
    JOIN dependencies d ON d.relid = f.confrelid
    WHERE f.contype = 'f'
), report AS (
    SELECT 'FOREIGN_KEY' AS category, f.conrelid::regclass::text AS source,
           jsonb_build_object('parent', f.confrelid::regclass::text,
                              'constraint', f.conname,
                              'definition', pg_get_constraintdef(f.oid),
                              'validated', f.convalidated) AS details
    FROM pg_constraint f JOIN dependencies d ON d.relid = f.confrelid
    WHERE f.contype = 'f'
    UNION ALL
    SELECT 'COLUMN', n.nspname || '.' || c.relname,
           jsonb_build_object('column', a.attname, 'type', format_type(a.atttypid,a.atttypmod), 'not_null', a.attnotnull)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p')
      AND (c.oid IN (SELECT relid FROM dependencies)
           OR (n.nspname IN ('public','auth','storage','shadow_account_lifecycle')
               AND (a.attname ~* '(^|_)(user|reader|author|owner|buyer|seller|sender|receiver|recipient|customer|payer|profile|account|follower|following|referrer|referred|admin|member|creator|uploader)(_|$)'
                    OR a.attname IN ('created_by','updated_by','email','uid','user','owner'))))
    UNION ALL
    SELECT 'TRIGGER', t.tgrelid::regclass::text,
           jsonb_build_object('name', t.tgname, 'definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled)
    FROM pg_trigger t WHERE NOT t.tgisinternal
      AND (t.tgrelid IN (SELECT relid FROM dependencies)
           OR t.tgrelid = to_regclass('shadow_account_lifecycle.deletion_records'))
    UNION ALL
    SELECT 'SCHEDULER', 'pg_cron', jsonb_build_object('installed', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'))
    UNION ALL
    SELECT 'QUEUE', 'shadow_account_lifecycle.expired_accounts_queue', jsonb_build_object('definition', pg_get_viewdef(to_regclass('shadow_account_lifecycle.expired_accounts_queue'), true))
)
SELECT category, source, details FROM report ORDER BY category, source, details::text;
