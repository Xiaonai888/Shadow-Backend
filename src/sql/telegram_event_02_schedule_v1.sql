BEGIN;

CREATE FUNCTION public.telegram_event_next_publish_v1(
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
  FOR i IN 0..7 LOOP
    candidate_day := first_day + i;
    IF candidate_day > DATE '9999-12-31' OR (p_end IS NOT NULL AND candidate_day > p_end) THEN EXIT; END IF;
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

REVOKE ALL ON FUNCTION public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz) TO service_role;

COMMIT;
