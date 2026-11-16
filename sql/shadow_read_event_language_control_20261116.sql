CREATE TABLE IF NOT EXISTS public.shadow_read_event_language_controls (
  language_code text PRIMARY KEY CHECK (language_code IN ('km', 'en', 'zh', 'ko', 'ja')),
  is_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.shadow_read_event_language_controls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shadow_read_event_language_controls FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.shadow_read_event_language_controls TO service_role;

INSERT INTO public.shadow_read_event_language_controls (language_code, is_enabled)
VALUES
  ('km', true),
  ('en', false),
  ('zh', false),
  ('ko', false),
  ('ja', false)
ON CONFLICT (language_code) DO NOTHING;
