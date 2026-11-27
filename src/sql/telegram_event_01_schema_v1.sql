BEGIN;

CREATE FUNCTION public.telegram_event_schedule_valid_v1(
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
  IF p_mode IS NULL OR p_mode NOT IN ('dates', 'weekly') OR p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(p_slots) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  IF p_mode = 'weekly' AND (p_start IS NULL OR (p_end IS NOT NULL AND p_end < p_start)) THEN RETURN false; END IF;
  IF p_mode = 'dates' AND (p_start IS NOT NULL OR p_end IS NOT NULL) THEN RETURN false; END IF;
  IF (p_start IS NOT NULL AND (p_start < DATE '2000-01-01' OR p_start > DATE '9999-12-31')) OR
     (p_end IS NOT NULL AND (p_end < DATE '2000-01-01' OR p_end > DATE '9999-12-31')) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_slots) LOOP
    IF jsonb_typeof(item) <> 'object' OR jsonb_typeof(item->'time') IS DISTINCT FROM 'string' OR
       (item->>'time') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
    IF p_mode = 'weekly' THEN
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

CREATE TABLE public.telegram_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  audience text NOT NULL CHECK (audience IN ('reader', 'author')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  schedule_mode text NOT NULL DEFAULT 'dates' CHECK (schedule_mode IN ('dates', 'weekly')),
  schedule_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_on date,
  ends_on date,
  next_publish_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (public.telegram_event_schedule_valid_v1(schedule_mode, schedule_slots, starts_on, ends_on)
    OR (status = 'draft' AND schedule_slots = '[]'::jsonb AND starts_on IS NULL AND ends_on IS NULL)),
  CHECK ((status = 'active' AND next_publish_at IS NOT NULL) OR (status <> 'active' AND next_publish_at IS NULL))
);

CREATE INDEX telegram_events_due_idx ON public.telegram_events (next_publish_at, id) WHERE status = 'active';
CREATE INDEX telegram_events_audience_idx ON public.telegram_events (audience, updated_at DESC, id) WHERE status <> 'archived';

CREATE TABLE public.telegram_event_contents (
  event_id uuid NOT NULL REFERENCES public.telegram_events(id) ON DELETE RESTRICT,
  language text NOT NULL CHECK (language IN ('km', 'en', 'zh', 'ko', 'ja')),
  enabled boolean NOT NULL DEFAULT false,
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 4000),
  image_url text CHECK (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url ~ '^https://[^[:space:]]+$')),
  image_key text CHECK (image_key IS NULL OR char_length(btrim(image_key)) BETWEEN 1 AND 1024),
  button_label text,
  button_url text,
  photo_file_id text CHECK (photo_file_id IS NULL OR char_length(photo_file_id) BETWEEN 1 AND 1024),
  photo_bot_key text CHECK (photo_bot_key IS NULL OR photo_bot_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, language),
  CHECK ((image_url IS NULL) = (image_key IS NULL)),
  CHECK ((photo_file_id IS NULL) = (photo_bot_key IS NULL)),
  CHECK (photo_file_id IS NULL OR image_key IS NOT NULL),
  CHECK (image_url IS NULL OR char_length(message) <= 1000),
  CHECK (NOT enabled OR char_length(btrim(message)) > 0 OR image_url IS NOT NULL),
  CHECK ((button_label IS NULL AND button_url IS NULL) OR
    (button_label IS NOT NULL AND button_url IS NOT NULL AND char_length(btrim(button_label)) BETWEEN 1 AND 64
      AND char_length(button_url) <= 2048 AND button_url ~ '^https://[^[:space:]]+$'))
);

CREATE INDEX telegram_event_contents_language_idx ON public.telegram_event_contents (language, event_id);

CREATE TABLE public.telegram_event_channels (
  language text PRIMARY KEY CHECK (language IN ('km', 'en', 'zh', 'ko', 'ja')),
  channel_id text UNIQUE CHECK (channel_id IS NULL OR channel_id ~ '^(-100[0-9]{5,17}|@[A-Za-z][A-Za-z0-9_]{4,31})$'),
  channel_name text CHECK (channel_name IS NULL OR char_length(channel_name) <= 200),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR channel_id IS NOT NULL)
);

INSERT INTO public.telegram_event_channels(language) VALUES ('km'), ('en'), ('zh'), ('ko'), ('ja');

CREATE TABLE public.telegram_event_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.telegram_events(id) ON DELETE RESTRICT,
  language text NOT NULL REFERENCES public.telegram_event_channels(language) ON DELETE RESTRICT,
  channel_id text,
  job_kind text NOT NULL CHECK (job_kind IN ('scheduled', 'manual')),
  job_key text NOT NULL CHECK (char_length(job_key) BETWEEN 1 AND 200),
  scheduled_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed', 'skipped', 'uncertain', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease_id uuid,
  lease_until timestamptz,
  telegram_message_id bigint CHECK (telegram_message_id IS NULL OR telegram_message_id > 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (event_id, language, job_key),
  CHECK (expires_at >= scheduled_at),
  CHECK ((status = 'sending' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR
         (status <> 'sending' AND lease_id IS NULL AND lease_until IS NULL)),
  CHECK (status <> 'sent' OR (telegram_message_id IS NOT NULL AND channel_id IS NOT NULL)),
  CHECK ((status IN ('sent', 'failed', 'skipped', 'uncertain', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX telegram_event_history_slot_idx ON public.telegram_event_history(event_id, language, scheduled_at) WHERE job_kind = 'scheduled';
CREATE INDEX telegram_event_history_ready_idx ON public.telegram_event_history(available_at, id) WHERE status IN ('pending', 'retry');
CREATE INDEX telegram_event_history_lease_idx ON public.telegram_event_history(lease_until, id) WHERE status = 'sending';
CREATE INDEX telegram_event_history_recent_idx ON public.telegram_event_history(created_at DESC, id);
CREATE INDEX telegram_event_history_language_idx ON public.telegram_event_history(language, created_at DESC, id);

CREATE FUNCTION public.telegram_event_touch_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_TABLE_NAME = 'telegram_event_contents' THEN
    IF NEW.image_key IS DISTINCT FROM OLD.image_key OR NEW.image_url IS DISTINCT FROM OLD.image_url THEN
      NEW.photo_file_id := NULL;
      NEW.photo_bot_key := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telegram_events_touch BEFORE UPDATE ON public.telegram_events FOR EACH ROW EXECUTE FUNCTION public.telegram_event_touch_v1();
CREATE TRIGGER telegram_event_contents_touch BEFORE UPDATE ON public.telegram_event_contents FOR EACH ROW EXECUTE FUNCTION public.telegram_event_touch_v1();
CREATE TRIGGER telegram_event_channels_touch BEFORE UPDATE ON public.telegram_event_channels FOR EACH ROW EXECUTE FUNCTION public.telegram_event_touch_v1();
CREATE TRIGGER telegram_event_history_touch BEFORE UPDATE ON public.telegram_event_history FOR EACH ROW EXECUTE FUNCTION public.telegram_event_touch_v1();

ALTER TABLE public.telegram_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_event_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_event_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_event_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_events, public.telegram_event_contents, public.telegram_event_channels, public.telegram_event_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_events, public.telegram_event_contents, public.telegram_event_channels, public.telegram_event_history TO service_role;
REVOKE ALL ON FUNCTION public.telegram_event_schedule_valid_v1(text,jsonb,date,date), public.telegram_event_touch_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_schedule_valid_v1(text,jsonb,date,date), public.telegram_event_touch_v1() TO service_role;

COMMIT;
