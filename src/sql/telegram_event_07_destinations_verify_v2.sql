WITH checks AS (
  SELECT 'five_language_rows' AS test_name,(SELECT count(*)=5 FROM public.telegram_event_channels) AS ok
  UNION ALL SELECT 'group_id_column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='telegram_event_channels' AND column_name='group_id')
  UNION ALL SELECT 'group_name_column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='telegram_event_channels' AND column_name='group_name')
  UNION ALL SELECT 'destination_kind_column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='telegram_event_history' AND column_name='destination_kind' AND is_nullable='NO')
  UNION ALL SELECT 'target_job_unique',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.telegram_event_history'::regclass AND conname='telegram_event_history_target_job_key' AND contype='u')
  UNION ALL SELECT 'target_slot_unique',EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='telegram_event_history_slot_idx' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%destination_kind%')
  UNION ALL SELECT 'different_chat_ids',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.telegram_event_channels'::regclass AND conname='telegram_event_distinct_targets')
  UNION ALL SELECT 'channel_table_rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.telegram_event_channels'::regclass)
  UNION ALL SELECT 'history_table_rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.telegram_event_history'::regclass)
  UNION ALL SELECT 'prepare_has_destinations',position('destination_kind' in pg_get_functiondef('public.telegram_event_prepare_v1()'::regprocedure))>0
  UNION ALL SELECT 'manual_has_destinations',position('destination_kind' in pg_get_functiondef('public.telegram_event_manual_v1(uuid,text,uuid)'::regprocedure))>0
  UNION ALL SELECT 'claim_has_destinations',position('DESTINATION_CHANGED' in pg_get_functiondef('public.telegram_event_claim_v1()'::regprocedure))>0
  UNION ALL SELECT 'activation_group_only',position('group_id' in pg_get_functiondef('public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)'::regprocedure))>0
  UNION ALL SELECT 'rpc_permissions_'||p::text,NOT has_function_privilege('anon',p,'EXECUTE') AND NOT has_function_privilege('authenticated',p,'EXECUTE') AND has_function_privilege('service_role',p,'EXECUTE') FROM unnest(ARRAY['public.telegram_event_prepare_v1()','public.telegram_event_manual_v1(uuid,text,uuid)','public.telegram_event_claim_v1()','public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)']) f(p)
)
SELECT test_name,CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result FROM checks ORDER BY test_name;
