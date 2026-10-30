BEGIN;

DO $seed$
DECLARE
  target_language record;
  source_slide record;
  new_slide_id public.slides.id%TYPE;
  slide_columns text;
  slide_expressions text;
  log_columns text;
  log_expressions text;
  insert_slide_sql text;
  insert_log_sql text;
  source_slide_count bigint;
  source_log_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.slides
    WHERE section_key IN (
      'home_top_slider_en',
      'home_top_slider_zh',
      'home_top_slider_ja',
      'home_top_slider_ko'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.admin_activity_logs
    WHERE section_key IN (
      'home_top_slider_en',
      'home_top_slider_zh',
      'home_top_slider_ja',
      'home_top_slider_ko'
    )
  ) THEN
    RAISE EXCEPTION 'Home Slide language data already exists. Migration cancelled without changing existing records.';
  END IF;

  SELECT COUNT(*) INTO source_slide_count
  FROM public.slides WHERE section_key = 'home_top_slider';

  SELECT COUNT(*) INTO source_log_count
  FROM public.admin_activity_logs WHERE section_key = 'home_top_slider' AND created_at >= now() - interval '90 days';

  CREATE TEMP TABLE _home_slide_seed_map ON COMMIT DROP AS
  SELECT id AS source_slide_id,
         id AS copied_slide_id,
         section_key AS destination_section_key
  FROM public.slides WHERE FALSE;

  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum),
         string_agg(
           CASE WHEN attname = 'section_key' THEN '$2'
                ELSE format('s.%I', attname)
           END,
           ', ' ORDER BY attnum
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
                WHEN attname = 'slide_id' THEN 'COALESCE(m.copied_slide_id, a.slide_id)'
                ELSE format('a.%I', attname)
           END,
           ', ' ORDER BY attnum
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
    RAISE EXCEPTION 'Unexpected slides or activity log schema. Migration cancelled.';
  END IF;

  insert_slide_sql := format(
    'INSERT INTO public.slides (%s) '
    || 'SELECT %s FROM public.slides s WHERE s.id = $1 RETURNING id',
    slide_columns,
    slide_expressions
  );

  insert_log_sql := format(
    'INSERT INTO public.admin_activity_logs (%s) '
    || 'SELECT %s FROM public.admin_activity_logs a '
    || 'LEFT JOIN _home_slide_seed_map m '
    || 'ON m.source_slide_id = a.slide_id '
    || 'AND m.destination_section_key = $1 '
    || 'WHERE a.section_key = $2 AND a.created_at >= now() - interval ''90 days''',
    log_columns,
    log_expressions
  );

  FOR target_language IN
    SELECT * FROM (VALUES
      ('en', 'home_top_slider_en'),
      ('zh', 'home_top_slider_zh'),
      ('ja', 'home_top_slider_ja'),
      ('ko', 'home_top_slider_ko')
    ) AS language(language_code, destination_key)
  LOOP
    FOR source_slide IN
      SELECT id FROM public.slides
      WHERE section_key = 'home_top_slider'
      ORDER BY order_index, created_at, id
    LOOP
      EXECUTE insert_slide_sql
        INTO new_slide_id
        USING source_slide.id, target_language.destination_key;

      INSERT INTO _home_slide_seed_map (
        source_slide_id, copied_slide_id, destination_section_key
      ) VALUES (
        source_slide.id, new_slide_id, target_language.destination_key
      );
    END LOOP;

    EXECUTE insert_log_sql
      USING target_language.destination_key, 'home_top_slider';

    IF (SELECT COUNT(*) FROM public.slides
        WHERE section_key = target_language.destination_key) <> source_slide_count THEN
      RAISE EXCEPTION 'Slide count mismatch for %', target_language.destination_key;
    END IF;

    IF (SELECT COUNT(*) FROM public.admin_activity_logs
        WHERE section_key = target_language.destination_key) <> source_log_count THEN
      RAISE EXCEPTION 'Record count mismatch for %', target_language.destination_key;
    END IF;
  END LOOP;
END
$seed$;

COMMIT;

SELECT target.section_key,
       (SELECT COUNT(*) FROM public.slides s
        WHERE s.section_key = target.section_key) AS slide_count,
       (SELECT COUNT(*) FROM public.admin_activity_logs l
        WHERE l.section_key = target.section_key) AS record_count
FROM (VALUES
  ('home_top_slider'),
  ('home_top_slider_en'),
  ('home_top_slider_zh'),
  ('home_top_slider_ja'),
  ('home_top_slider_ko')
) AS target(section_key);
