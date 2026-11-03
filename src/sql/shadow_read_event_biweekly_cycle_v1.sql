BEGIN;
ALTER TABLE public.shadow_read_event_weeks
  DROP CONSTRAINT IF EXISTS shadow_read_event_week_cycle_check;
ALTER TABLE public.shadow_read_event_weeks
  ADD CONSTRAINT shadow_read_event_week_cycle_check
  CHECK (starts_on >= DATE '2026-11-02'
    AND (starts_on - DATE '2026-11-02') % 14 = 0
    AND EXTRACT(ISODOW FROM starts_on) = 1);
COMMIT;
