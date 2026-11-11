
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') OR pg_catalog.to_regprocedure('public.shadow_studio_cleanup_advanced_metrics()') IS NULL THEN
    RAISE EXCEPTION 'Install pg_cron and Shadow Studio advanced metrics first';
  END IF;
END $$;
SELECT cron.schedule('shadow-studio-advanced-cleanup', '15 3 * * *', 'SELECT public.shadow_studio_cleanup_advanced_metrics()');
