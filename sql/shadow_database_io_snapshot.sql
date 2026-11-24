BEGIN;
CREATE FUNCTION public.shadow_database_io_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
WITH raw AS MATERIALIZED (
  SELECT s.userid, s.queryid, s.calls, s.rows, s.total_exec_time,
    s.shared_blks_read, s.shared_blks_hit, s.shared_blks_dirtied,
    s.shared_blks_written, s.temp_blks_read, s.temp_blks_written, s.wal_bytes,
    lower(left(s.query, 16000)) AS q
  FROM extensions.pg_stat_statements s
  WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND s.toplevel AND s.queryid IS NOT NULL AND s.calls > 0
), bounded AS MATERIALIZED (
  SELECT * FROM raw ORDER BY userid, queryid LIMIT 5000
), classified AS (
  SELECT b.*, ARRAY(SELECT v.target FROM (VALUES
    ('shadow_database_io_snapshot_v1'), ('evaluate_spam_guard'), ('reader_presence'),
    ('reader_devices'), ('reader_sessions'), ('reader_reading_reward_events'),
    ('record_reader_reading_reward_session'), ('reader_reading_rewards'),
    ('reading_progress'), ('episode_unlocks'), ('episode_unlock_transactions'),
    ('system_usage_snapshots'), ('system_usage_incidents'), ('work_kill_switches'),
    ('claim_binance_usdt_alerts'), ('expire_due_chat_messages'),
    ('author_page_stories'), ('reader_stories'), ('discover'), ('notifications'),
    ('telegram_payments'), ('cron.job_run_details'), ('stories'), ('episodes')
  ) AS v(target) WHERE strpos(b.q, v.target) > 0) AS targets
  FROM bounded b
)
SELECT jsonb_build_object(
  'version', 1,
  'captured_at', clock_timestamp(),
  'server_started_at', pg_postmaster_start_time(),
  'stats_reset', (SELECT stats_reset FROM extensions.pg_stat_statements_info),
  'dealloc', (SELECT dealloc::text FROM extensions.pg_stat_statements_info),
  'block_bytes', current_setting('block_size')::integer,
  'tracked_count', (SELECT count(*) FROM raw),
  'database', (SELECT jsonb_build_object('stats_reset', d.stats_reset,
    'blks_read', d.blks_read::text, 'blks_hit', d.blks_hit::text,
    'temp_bytes', d.temp_bytes::text, 'deadlocks', d.deadlocks::text,
    'xact_commit', d.xact_commit::text, 'xact_rollback', d.xact_rollback::text)
    FROM pg_stat_database d WHERE d.datname = current_database()),
  'activity', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM (
    SELECT backend_type, state, wait_event_type, count(*) AS connections
    FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
    GROUP BY backend_type, state, wait_event_type
  ) a),
  'columns', jsonb_build_array('key','targets','calls','rows','exec_ms','read_blocks','hit_blocks','dirty_blocks','written_blocks','temp_read_blocks','temp_written_blocks','wal_bytes'),
  'queries', (SELECT coalesce(jsonb_agg(jsonb_build_array(
    userid::text || ':' || queryid::text, targets, calls::text, rows::text,
    total_exec_time, shared_blks_read::text, shared_blks_hit::text,
    shared_blks_dirtied::text, shared_blks_written::text, temp_blks_read::text,
    temp_blks_written::text, wal_bytes::text) ORDER BY userid, queryid), '[]'::jsonb) FROM classified)
);
$fn$;
REVOKE ALL ON FUNCTION public.shadow_database_io_snapshot_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_database_io_snapshot_v1() TO service_role;
COMMIT;
