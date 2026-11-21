CREATE TABLE IF NOT EXISTS public.telegram_report_error_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_payment_id uuid NOT NULL REFERENCES public.telegram_payments(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  stage text NOT NULL CHECK (stage IN ('initial_send', 'retry_send', 'confirmation_save')),
  error_message text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,
  report_message_id text
);

CREATE INDEX IF NOT EXISTS telegram_report_error_history_created_at_idx
  ON public.telegram_report_error_history (created_at);

CREATE INDEX IF NOT EXISTS telegram_report_error_history_payment_open_idx
  ON public.telegram_report_error_history (telegram_payment_id)
  WHERE resolved_at IS NULL;

ALTER TABLE public.telegram_report_error_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telegram_report_error_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_report_error_history TO service_role;
