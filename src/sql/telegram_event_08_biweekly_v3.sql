BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.telegram_event_schedule_valid_v1(
  p_mode text, p_slots jsonb, p_start date, p_end date
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public
AS $$
DECLARE
  item jsonb;
  slot_date date;
  slot_key text;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('dates', 'weekly', 'biweekly') OR p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(p_slots) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  IF p_mode IN ('weekly', 'biweekly') AND (p_start IS NULL OR (p_end IS NOT NULL AND p_end < p_start)) THEN RETURN false; END IF;
  IF p_mode = 'dates' AND (p_start IS NOT NULL OR p_end IS NOT NULL) THEN RETURN false; END IF;
  IF (p_start IS NOT NULL AND (p_start < DATE '2000-01-01' OR p_start > DATE '9999-12-31')) OR
     (p_end IS NOT NULL AND (p_end < DATE '2000-01-01' OR p_end > DATE '9999-12-31')) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_slots) LOOP
    IF jsonb_typeof(item) <> 'object' OR jsonb_typeof(item->'time') IS DISTINCT FROM 'string' OR
       (item->>'time') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
    IF p_mode IN ('weekly', 'biweekly') THEN
      IF NOT (item ? 'day') OR jsonb_typeof(item->'day') <> 'number' OR
         (item->>'day') !~ '^[0-6]$' OR (item - 'day' - 'time') <> '{}'::jsonb THEN RETURN false; END IF;
      slot_key := (item->>'day') || 'T' || (item->>'time');
    ELSE
      IF jsonb_typeof(item->'date') IS DISTINCT FROM 'string' OR
         (item->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR
         (item - 'date' - 'time') <> '{}'::jsonb THEN RETURN false; END IF;
      slot_date := (item->>'date')::date;
      IF slot_date < DATE '2000-01-01' OR slot_date > DATE '9999-12-31' THEN RETURN false; END IF;
      slot_key := (item->>'date') || 'T' || (item->>'time');
    END IF;
    IF slot_key = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, slot_key);
  END LOOP;
  RETURN true;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.telegram_event_next_publish_v1(
  p_mode text, p_slots jsonb, p_start date, p_end date, p_after timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public
AS $$
DECLARE
  local_day date;
  first_day date;
  candidate_day date;
  candidate timestamptz;
  result timestamptz;
  item jsonb;
  i integer;
BEGIN
  IF p_after IS NULL OR NOT isfinite(p_after) OR NOT public.telegram_event_schedule_valid_v1(p_mode, p_slots, p_start, p_end) THEN
    RETURN NULL;
  END IF;
  IF p_mode = 'dates' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(p_slots) LOOP
      candidate := ((item->>'date')::date + (item->>'time')::time) AT TIME ZONE 'Asia/Phnom_Penh';
      IF candidate > p_after AND (result IS NULL OR candidate < result) THEN result := candidate; END IF;
    END LOOP;
    RETURN result;
  END IF;
  local_day := (p_after AT TIME ZONE 'Asia/Phnom_Penh')::date;
  first_day := greatest(local_day, p_start);
  IF p_end IS NOT NULL AND first_day > p_end THEN RETURN NULL; END IF;
  FOR i IN 0..(CASE WHEN p_mode = 'biweekly' THEN 14 ELSE 7 END) LOOP
    candidate_day := first_day + i;
    IF candidate_day > DATE '9999-12-31' OR (p_end IS NOT NULL AND candidate_day > p_end) THEN EXIT; END IF;
    IF p_mode = 'biweekly' AND mod(candidate_day - p_start, 14) >= 7 THEN CONTINUE; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_slots) LOOP
      IF extract(dow FROM candidate_day)::integer = (item->>'day')::integer THEN
        candidate := (candidate_day + (item->>'time')::time) AT TIME ZONE 'Asia/Phnom_Penh';
        IF candidate > p_after AND (result IS NULL OR candidate < result) THEN result := candidate; END IF;
      END IF;
    END LOOP;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

ALTER TABLE public.telegram_events DROP CONSTRAINT telegram_events_schedule_mode_check;
ALTER TABLE public.telegram_events ADD CONSTRAINT telegram_events_schedule_mode_check CHECK (schedule_mode IN ('dates','weekly','biweekly'));
REVOKE ALL ON FUNCTION public.telegram_event_schedule_valid_v1(text,jsonb,date,date), public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_schedule_valid_v1(text,jsonb,date,date), public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz) TO service_role;
COMMIT;
