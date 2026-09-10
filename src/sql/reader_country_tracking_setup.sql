ALTER TABLE public.reader_presence
  ADD COLUMN IF NOT EXISTS first_country_code text,
  ADD COLUMN IF NOT EXISTS first_country_name text,
  ADD COLUMN IF NOT EXISTS last_country_code text,
  ADD COLUMN IF NOT EXISTS last_country_name text,
  ADD COLUMN IF NOT EXISTS country_first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS country_last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_reader_presence_last_country_code
  ON public.reader_presence (last_country_code);

CREATE INDEX IF NOT EXISTS idx_reader_presence_country_last_seen_at
  ON public.reader_presence (country_last_seen_at DESC);
