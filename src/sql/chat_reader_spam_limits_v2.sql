BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_reader_send_limits (
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  first_reply_pending boolean NOT NULL DEFAULT true,
  pending_sent_count integer NOT NULL DEFAULT 0,
  pending_from_daily boolean NOT NULL DEFAULT false,
  day_key date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Phnom_Penh')::date),
  daily_unanswered_count integer NOT NULL DEFAULT 0,
  last_inbound_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_user_id, recipient_user_id),
  CONSTRAINT chat_reader_send_limits_distinct_users CHECK (sender_user_id <> recipient_user_id),
  CONSTRAINT chat_reader_send_limits_nonnegative CHECK (pending_sent_count >= 0 AND daily_unanswered_count >= 0)
);

ALTER TABLE public.chat_reader_send_limits ADD COLUMN IF NOT EXISTS pending_from_daily boolean NOT NULL DEFAULT false;
ALTER TABLE public.chat_reader_send_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_reader_send_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_reader_send_limits TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_chat_ensure_sender_state_v1(
  p_conversation_id uuid,
  p_sender_user_id uuid
)
RETURNS public.chat_reader_send_limits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_conversation public.chat_conversations%ROWTYPE;
  v_state public.chat_reader_send_limits%ROWTYPE;
  v_recipient_id uuid;
  v_last_inbound timestamptz;
  v_cleared_at timestamptz;
  v_pending boolean;
  v_pending_count integer;
  v_daily_count integer;
  v_day date := (now() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Phnom_Penh') AT TIME ZONE 'Asia/Phnom_Penh';
BEGIN
  SELECT * INTO v_conversation
  FROM public.chat_conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND OR v_conversation.conversation_type IS DISTINCT FROM 'reader_reader'
    OR v_conversation.is_group IS TRUE THEN
    RETURN NULL;
  END IF;

  SELECT p.user_id INTO v_recipient_id
  FROM public.chat_participants p
  WHERE p.conversation_id = p_conversation_id
    AND p.user_id <> p_sender_user_id
  LIMIT 1;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PARTICIPANT_MISSING';
  END IF;

  SELECT * INTO v_state
  FROM public.chat_reader_send_limits
  WHERE sender_user_id = p_sender_user_id
    AND recipient_user_id = v_recipient_id
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT max(m.created_at) INTO v_last_inbound
    FROM public.chat_messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.sender_user_id = v_recipient_id;

    SELECT greatest(v_conversation.cleared_for_all_at, p.cleared_at)
    INTO v_cleared_at
    FROM public.chat_participants p
    WHERE p.conversation_id = p_conversation_id
      AND p.user_id = p_sender_user_id
    LIMIT 1;

    v_pending := v_last_inbound IS NULL
      OR (v_cleared_at IS NOT NULL AND v_cleared_at >= v_last_inbound);

    SELECT count(*)::integer INTO v_pending_count
    FROM public.chat_messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.sender_user_id = p_sender_user_id
      AND (v_last_inbound IS NULL OR m.created_at > v_last_inbound);

    SELECT count(*)::integer INTO v_daily_count
    FROM public.chat_messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.sender_user_id = p_sender_user_id
      AND m.created_at >= v_day_start
      AND (v_last_inbound IS NULL OR m.created_at > v_last_inbound);

    INSERT INTO public.chat_reader_send_limits (
      sender_user_id, recipient_user_id, first_reply_pending,
      pending_sent_count, day_key, daily_unanswered_count, last_inbound_at
    ) VALUES (
      p_sender_user_id, v_recipient_id, v_pending,
      CASE WHEN v_pending THEN v_pending_count ELSE 0 END,
      v_day, CASE WHEN v_pending THEN 0 ELSE v_daily_count END, v_last_inbound
    ) ON CONFLICT (sender_user_id, recipient_user_id) DO NOTHING;

    SELECT * INTO STRICT v_state
    FROM public.chat_reader_send_limits
    WHERE sender_user_id = p_sender_user_id
      AND recipient_user_id = v_recipient_id
    FOR UPDATE;
  END IF;

  IF v_state.day_key IS DISTINCT FROM v_day THEN
    UPDATE public.chat_reader_send_limits
    SET day_key = v_day,
        daily_unanswered_count = 0,
        pending_sent_count = CASE
          WHEN first_reply_pending AND pending_from_daily THEN 0
          ELSE pending_sent_count
        END,
        pending_from_daily = false,
        updated_at = now()
    WHERE sender_user_id = p_sender_user_id
      AND recipient_user_id = v_recipient_id
    RETURNING * INTO v_state;
  END IF;

  RETURN v_state;
END;
$function$;

CREATE OR REPLACE FUNCTION public.shadow_chat_sender_quota_v1(
  p_conversation_id uuid,
  p_sender_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_conversation public.chat_conversations%ROWTYPE;
  v_state public.chat_reader_send_limits%ROWTYPE;
  v_limit integer;
  v_sent integer;
  v_can_send boolean;
  v_reset_at timestamptz;
BEGIN
  SELECT * INTO v_conversation
  FROM public.chat_conversations
  WHERE id = p_conversation_id;

  IF NOT FOUND OR v_conversation.conversation_type IS DISTINCT FROM 'reader_reader'
    OR v_conversation.is_group IS TRUE THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.chat_participants p
    WHERE p.conversation_id = p_conversation_id
      AND p.user_id = p_sender_user_id
  ) THEN
    RETURN NULL;
  END IF;

  v_state := public.shadow_chat_ensure_sender_state_v1(p_conversation_id, p_sender_user_id);
  IF v_state IS NULL THEN
    RETURN NULL;
  END IF;

  v_limit := CASE WHEN v_state.first_reply_pending THEN 5 ELSE 20 END;
  v_sent := CASE WHEN v_state.first_reply_pending
    THEN v_state.pending_sent_count ELSE v_state.daily_unanswered_count END;

  v_can_send := (
    v_conversation.request_status = 'accepted'
    OR (
      v_conversation.request_status = 'pending'
      AND v_conversation.created_by_user_id = p_sender_user_id
    )
  ) AND v_sent < v_limit;

  IF NOT v_state.first_reply_pending THEN
    v_reset_at := ((v_state.day_key + 1)::timestamp AT TIME ZONE 'Asia/Phnom_Penh');
  END IF;

  RETURN jsonb_build_object(
    'can_send', v_can_send,
    'mode', CASE WHEN v_state.first_reply_pending THEN 'first_reply' ELSE 'daily_unanswered' END,
    'limit', v_limit,
    'sent', v_sent,
    'remaining', greatest(0, v_limit - v_sent),
    'next_reset_at', v_reset_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.shadow_chat_enforce_reader_send_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_conversation public.chat_conversations%ROWTYPE;
  v_state public.chat_reader_send_limits%ROWTYPE;
  v_used integer;
  v_limit integer;
BEGIN
  SELECT * INTO v_conversation
  FROM public.chat_conversations
  WHERE id = NEW.conversation_id
  FOR UPDATE;

  IF NOT FOUND OR v_conversation.conversation_type IS DISTINCT FROM 'reader_reader'
    OR v_conversation.is_group IS TRUE THEN
    RETURN NEW;
  END IF;

  IF v_conversation.request_status = 'blocked' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CHAT_BLOCKED';
  END IF;
  IF v_conversation.request_status = 'declined' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REQUEST_DECLINED';
  END IF;
  IF v_conversation.request_status = 'pending'
    AND v_conversation.created_by_user_id IS DISTINCT FROM NEW.sender_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REQUEST_NOT_ACCEPTED';
  END IF;

  v_state := public.shadow_chat_ensure_sender_state_v1(NEW.conversation_id, NEW.sender_user_id);
  IF v_state IS NULL THEN
    RETURN NEW;
  END IF;

  v_limit := CASE WHEN v_state.first_reply_pending THEN 5 ELSE 20 END;
  v_used := CASE WHEN v_state.first_reply_pending
    THEN v_state.pending_sent_count ELSE v_state.daily_unanswered_count END;

  IF v_used >= v_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = CASE WHEN v_state.first_reply_pending
        THEN 'FIRST_REPLY_5_MESSAGE_LIMIT'
        ELSE 'DAILY_UNANSWERED_20_MESSAGE_LIMIT' END;
  END IF;

  IF v_conversation.request_status = 'pending' THEN
    NEW.is_request_message := NOT EXISTS (
      SELECT 1 FROM public.chat_messages m
      WHERE m.conversation_id = NEW.conversation_id
        AND m.is_request_message IS TRUE
    );
  ELSE
    NEW.is_request_message := false;
  END IF;

  UPDATE public.chat_reader_send_limits
  SET pending_sent_count = pending_sent_count + CASE WHEN v_state.first_reply_pending THEN 1 ELSE 0 END,
      pending_from_daily = CASE
        WHEN v_state.first_reply_pending THEN false
        ELSE pending_from_daily
      END,
      daily_unanswered_count = daily_unanswered_count + CASE WHEN v_state.first_reply_pending THEN 0 ELSE 1 END,
      updated_at = now()
  WHERE sender_user_id = NEW.sender_user_id
    AND recipient_user_id = v_state.recipient_user_id;

  UPDATE public.chat_reader_send_limits
  SET first_reply_pending = false,
      pending_sent_count = 0,
      pending_from_daily = false,
      daily_unanswered_count = 0,
      day_key = (now() AT TIME ZONE 'Asia/Phnom_Penh')::date,
      last_inbound_at = now(),
      updated_at = now()
  WHERE sender_user_id = v_state.recipient_user_id
    AND recipient_user_id = NEW.sender_user_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.shadow_chat_mark_new_session_v1(
  p_conversation_id uuid,
  p_sender_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state public.chat_reader_send_limits%ROWTYPE;
  v_count integer;
BEGIN
  v_state := public.shadow_chat_ensure_sender_state_v1(p_conversation_id, p_sender_user_id);
  IF v_state IS NULL THEN
    RETURN;
  END IF;

  v_count := CASE WHEN v_state.first_reply_pending THEN v_state.pending_sent_count
    ELSE v_state.daily_unanswered_count END;

  UPDATE public.chat_reader_send_limits
  SET first_reply_pending = true,
      pending_sent_count = v_count,
      pending_from_daily = CASE
        WHEN v_state.first_reply_pending THEN v_state.pending_from_daily
        ELSE true
      END,
      daily_unanswered_count = 0,
      updated_at = now()
  WHERE sender_user_id = v_state.sender_user_id
    AND recipient_user_id = v_state.recipient_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.shadow_chat_on_delete_new_session_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_other uuid;
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
    OR NEW.deleted_by_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.shadow_chat_mark_new_session_v1(
    NEW.conversation_id, NEW.deleted_by_user_id
  );

  IF NEW.delete_scope = 'for_both' THEN
    SELECT p.user_id INTO v_other
    FROM public.chat_participants p
    WHERE p.conversation_id = NEW.conversation_id
      AND p.user_id <> NEW.deleted_by_user_id
    LIMIT 1;
    IF v_other IS NOT NULL THEN
      PERFORM public.shadow_chat_mark_new_session_v1(NEW.conversation_id, v_other);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_pending_reader_request_limit_trigger ON public.chat_messages;
DROP TRIGGER IF EXISTS shadow_chat_enforce_reader_send_trigger_v1 ON public.chat_messages;
CREATE TRIGGER shadow_chat_enforce_reader_send_trigger_v1
BEFORE INSERT ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION public.shadow_chat_enforce_reader_send_v1();

DROP TRIGGER IF EXISTS shadow_chat_on_delete_new_session_trigger_v1 ON public.chat_participants;
CREATE TRIGGER shadow_chat_on_delete_new_session_trigger_v1
AFTER UPDATE OF deleted_at ON public.chat_participants
FOR EACH ROW EXECUTE FUNCTION public.shadow_chat_on_delete_new_session_v1();

REVOKE ALL ON FUNCTION public.shadow_chat_ensure_sender_state_v1(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_chat_sender_quota_v1(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_chat_enforce_reader_send_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_chat_mark_new_session_v1(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_chat_on_delete_new_session_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_chat_ensure_sender_state_v1(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_chat_sender_quota_v1(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_chat_enforce_reader_send_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_chat_mark_new_session_v1(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_chat_on_delete_new_session_v1() TO service_role;

COMMIT;

SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.chat_messages'::regclass
      AND tgname = 'shadow_chat_enforce_reader_send_trigger_v1'
      AND tgenabled <> 'D'
  ) AND EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.chat_participants'::regclass
      AND tgname = 'shadow_chat_on_delete_new_session_trigger_v1'
      AND tgenabled <> 'D'
  ) THEN 'OK' ELSE 'MISSING' END AS shadow_chat_spam_guard_status;
