WITH relevant_tables AS (
    SELECT DISTINCT c.table_schema, c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND (
          c.column_name IN ('user_id', 'reader_id', 'owner_id', 'buyer_id', 'author_id', 'sender_id', 'receiver_id', 'recipient_id', 'profile_id', 'customer_id', 'payer_id', 'referrer_id', 'referred_id', 'created_by', 'follower_id', 'following_id')
          OR c.table_name IN ('users', 'user_wallets', 'reader_sessions', 'reader_devices', 'reader_presence')
      )
    UNION
    SELECT 'auth', 'users'
), report AS (
    SELECT 'COLUMN' AS category, c.table_schema || '.' || c.table_name AS source,
        jsonb_build_object('column', c.column_name, 'type', c.data_type, 'udt', c.udt_name, 'nullable', c.is_nullable) AS details
    FROM information_schema.columns c
    JOIN relevant_tables t USING (table_schema, table_name)
    WHERE c.table_name IN ('users', 'user_wallets', 'reader_sessions', 'reader_devices', 'reader_presence')
       OR c.column_name IN ('user_id', 'reader_id', 'owner_id', 'buyer_id', 'author_id', 'sender_id', 'receiver_id', 'recipient_id', 'profile_id', 'customer_id', 'payer_id', 'referrer_id', 'referred_id', 'created_by', 'follower_id', 'following_id')
    UNION ALL
    SELECT 'FOREIGN_KEY', ns.nspname || '.' || cl.relname,
        jsonb_build_object('constraint', co.conname, 'definition', pg_get_constraintdef(co.oid), 'validated', co.convalidated)
    FROM pg_constraint co
    JOIN pg_class cl ON cl.oid = co.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE co.contype = 'f' AND co.confrelid IN (to_regclass('public.users'), to_regclass('auth.users'))
    UNION ALL
    SELECT 'TRIGGER', event_object_schema || '.' || event_object_table,
        jsonb_build_object('name', trigger_name, 'event', event_manipulation, 'timing', action_timing)
    FROM information_schema.triggers
    WHERE event_object_schema = 'public' AND event_object_table IN ('users', 'reader_sessions', 'user_wallets')
    UNION ALL
    SELECT 'RLS', n.nspname || '.' || c.relname,
        jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN relevant_tables t ON t.table_schema = n.nspname AND t.table_name = c.relname
    WHERE c.relkind IN ('r','p')
)
SELECT * FROM report ORDER BY category, source, details::text;
