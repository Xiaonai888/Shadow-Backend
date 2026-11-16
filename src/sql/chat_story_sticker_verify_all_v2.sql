WITH expected(name, kind) AS (
  VALUES
    ('sticker_folders', 'table'),
    ('sticker_library', 'table'),
    ('chat_story_sticker_saved_packs', 'table'),
    ('chat_story_sticker_favorites', 'table'),
    ('chat_story_sticker_recent', 'table'),
    ('chat_story_sticker_daily_unique', 'table'),
    ('chat_story_sticker_daily_stats', 'table'),
    ('chat_story_sticker_pack_catalog', 'view'),
    ('chat_story_sticker_trending_7d', 'view'),
    ('chat_story_record_sticker_use(uuid,uuid)', 'function')
), results AS (
  SELECT name, kind,
    CASE
      WHEN kind = 'function' THEN CASE WHEN to_regprocedure('public.' || name) IS NULL THEN 'MISSING' ELSE 'PASS' END
      WHEN to_regclass('public.' || name) IS NULL THEN 'MISSING'
      WHEN kind = 'table' AND NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || name)) AND name NOT IN ('sticker_folders', 'sticker_library') THEN 'RLS_OFF'
      ELSE 'PASS'
    END AS status
  FROM expected
)
SELECT name, kind, status FROM results ORDER BY kind, name;
