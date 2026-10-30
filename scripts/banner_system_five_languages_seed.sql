BEGIN;

DO $seed$
DECLARE
  source_section RECORD;
  target_language RECORD;
  source_slide RECORD;
  new_slide_id public.slides.id%TYPE;
  destination_key TEXT;
  slide_columns TEXT;
  slide_expressions TEXT;
  log_columns TEXT;
  log_expressions TEXT;
  insert_slide_sql TEXT;
  insert_log_sql TEXT;
  source_slide_count BIGINT;
  source_log_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.slides
    WHERE section_key IN (
      'shadow_spotlight_en',
      'shadow_spotlight_zh',
      'shadow_spotlight_ja',
      'shadow_spotlight_ko',
      'editor_weekly_picks_en',
      'editor_weekly_picks_zh',
      'editor_weekly_picks_ja',
      'editor_weekly_picks_ko',
      'event_perks_hub_en',
      'event_perks_hub_zh',
      'event_perks_hub_ja',
      'event_perks_hub_ko'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.admin_activity_logs
    WHERE section_key IN (
      'shadow_spotlight_en',
      'shadow_spotlight_zh',
      'shadow_spotlight_ja',
      'shadow_spotlight_ko',
      'editor_weekly_picks_en',
      'editor_weekly_picks_zh',
      'editor_weekly_picks_ja',
      'editor_weekly_picks_ko',
      'event_perks_hub_en',
      'event_perks_hub_zh',
      'event_perks_hub_ja',
      'event_perks_hub_ko'
    )
  ) THEN
    RAISE EXCEPTION 'Banner language data already exists. Migration cancelled without modifying records.';
  END IF;

  CREATE TEMP TABLE _banner_language_seed_map ON COMMIT DROP AS
  SELECT id AS source_slide_id,
         id AS copied_slide_id,
         section_key AS destination_section_key
  FROM public.slides WHERE FALSE;

  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum),
         string_agg(
           CASE WHEN attname = 'section_key' THEN '$2'
                ELSE format('s.%I', attname)
           END, ', ' ORDER BY attnum
         )
    INTO slide_columns, slide_expressions
  FROM pg_attribute
  WHERE attrelid = 'public.slides'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attname <> 'id'
    AND attgenerated = ''
    AND attidentity = '';

  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum),
         string_agg(
           CASE WHEN attname = 'section_key' THEN '$1'
                WHEN attname = 'slide_id' THEN 'm.copied_slide_id'
                ELSE format('a.%I', attname)
           END, ', ' ORDER BY attnum
         )
    INTO log_columns, log_expressions
  FROM pg_attribute
  WHERE attrelid = 'public.admin_activity_logs'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attname <> 'id'
    AND attgenerated = ''
    AND attidentity = '';

  IF slide_columns IS NULL OR log_columns IS NULL THEN
    RAISE EXCEPTION 'Unexpected banner or activity log schema. Migration cancelled.';
  END IF;

  insert_slide_sql := format(
    'INSERT INTO public.slides (%s) '
    || 'SELECT %s FROM public.slides s WHERE s.id = $1 RETURNING id',
    slide_columns, slide_expressions
  );

  insert_log_sql := format(
    'INSERT INTO public.admin_activity_logs (%s) '
    || 'SELECT %s FROM public.admin_activity_logs a '
    || 'LEFT JOIN _banner_language_seed_map m '
    || 'ON m.source_slide_id = a.slide_id '
    || 'AND m.destination_section_key = $1 '
    || 'WHERE a.section_key = $2',
    log_columns, log_expressions
  );

  FOR source_section IN
    SELECT section_key FROM (VALUES
      ('shadow_spotlight'),
      ('editor_weekly_picks'),
      ('event_perks_hub')
    ) AS sections(section_key)
  LOOP
    SELECT COUNT(*) INTO source_slide_count
    FROM public.slides WHERE section_key = source_section.section_key;

    SELECT COUNT(*) INTO source_log_count
    FROM public.admin_activity_logs WHERE section_key = source_section.section_key;

    FOR target_language IN
      SELECT code FROM (VALUES ('en'), ('zh'), ('ja'), ('ko')) AS languages(code)
    LOOP
      destination_key := source_section.section_key || '_' || target_language.code;

      FOR source_slide IN
        SELECT id FROM public.slides
        WHERE section_key = source_section.section_key
        ORDER BY order_index, created_at, id
      LOOP
        EXECUTE insert_slide_sql INTO new_slide_id
          USING source_slide.id, destination_key;

        INSERT INTO _banner_language_seed_map (
          source_slide_id, copied_slide_id, destination_section_key
        ) VALUES (
          source_slide.id, new_slide_id, destination_key
        );
      END LOOP;

      EXECUTE insert_log_sql
        USING destination_key, source_section.section_key;

      IF (SELECT COUNT(*) FROM public.slides
          WHERE section_key = destination_key) <> source_slide_count THEN
        RAISE EXCEPTION 'Banner count mismatch for %', destination_key;
      END IF;

      IF (SELECT COUNT(*) FROM public.admin_activity_logs
          WHERE section_key = destination_key) <> source_log_count THEN
        RAISE EXCEPTION 'Record count mismatch for %', destination_key;
      END IF;
    END LOOP;
  END LOOP;
END
$seed$;

COMMIT;

SELECT section_key,
       (SELECT COUNT(*) FROM public.slides s
        WHERE s.section_key = x.section_key) AS banner_count,
       (SELECT COUNT(*) FROM public.admin_activity_logs a
        WHERE a.section_key = x.section_key) AS record_count
FROM (VALUES
  ('shadow_spotlight'),
  ('editor_weekly_picks'),
  ('event_perks_hub'),
  ('shadow_spotlight_en'),
  ('shadow_spotlight_zh'),
  ('shadow_spotlight_ja'),
  ('shadow_spotlight_ko'),
  ('editor_weekly_picks_en'),
  ('editor_weekly_picks_zh'),
  ('editor_weekly_picks_ja'),
  ('editor_weekly_picks_ko'),
  ('event_perks_hub_en'),
  ('event_perks_hub_zh'),
  ('event_perks_hub_ja'),
  ('event_perks_hub_ko')
) AS x(section_key);
