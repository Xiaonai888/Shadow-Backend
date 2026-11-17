BEGIN;

CREATE TABLE IF NOT EXISTS public.mass_mention_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('reader_post_comment', 'author_post_comment')),
  source_id uuid NOT NULL,
  post_id uuid NOT NULL,
  author_page_id uuid,
  tag text NOT NULL CHECK (tag IN ('followers', 'highlight')),
  cursor_follower_id uuid,
  delivered_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_user_id, source_kind, source_id, tag)
);

CREATE TABLE IF NOT EXISTS public.mass_mention_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.mass_mention_jobs(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_user_id, recipient_user_id, source_kind, source_id)
);

CREATE TABLE IF NOT EXISTS public.mass_mention_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notification_id uuid,
  item_count integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  last_link text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS mass_mention_jobs_pending_idx
  ON public.mass_mention_jobs (available_at, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS mass_mention_jobs_sender_limit_idx
  ON public.mass_mention_jobs (sender_user_id, tag, created_at DESC);
CREATE INDEX IF NOT EXISTS mass_mention_digests_lookup_idx
  ON public.mass_mention_digests (sender_user_id, recipient_user_id, first_at DESC);
CREATE INDEX IF NOT EXISTS mass_mention_receipts_recipient_idx
  ON public.mass_mention_receipts (recipient_user_id, created_at DESC);

ALTER TABLE public.mass_mention_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_mention_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_mention_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mass_mention_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mass_mention_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mass_mention_digests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mass_mention_jobs TO service_role;
GRANT SELECT, INSERT ON public.mass_mention_receipts TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.mass_mention_digests TO service_role;

CREATE OR REPLACE FUNCTION public.mass_mention_enqueue_job(
  p_sender_user_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_post_id uuid,
  p_tag text,
  p_author_page_id uuid DEFAULT NULL
)
RETURNS TABLE(job_id uuid, result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_total integer;
  v_limit integer;
  v_valid boolean;
  v_tag_pattern text;
BEGIN
  IF p_sender_user_id IS NULL OR p_source_id IS NULL OR p_post_id IS NULL
     OR p_tag IS NULL OR p_source_kind IS NULL
     OR p_tag NOT IN ('followers', 'highlight')
     OR p_source_kind NOT IN ('reader_post_comment', 'author_post_comment') THEN
    RAISE EXCEPTION 'Invalid mass mention source';
  END IF;
  v_tag_pattern := CASE WHEN p_tag = 'followers'
    THEN '(^|[^A-Za-z0-9_@./])@followers?([^A-Za-z0-9_]|$)'
    ELSE '(^|[^A-Za-z0-9_@./])@highlight([^A-Za-z0-9_]|$)' END;
  IF p_source_kind = 'reader_post_comment' AND p_author_page_id IS NOT NULL THEN
    RAISE EXCEPTION 'Reader comment cannot use an author page audience';
  END IF;

  IF p_source_kind = 'reader_post_comment' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.reader_post_comments c
      JOIN public.reader_posts p ON p.id = c.post_id
      WHERE c.id = p_source_id AND c.user_id = p_sender_user_id
        AND c.post_id = p_post_id AND c.is_hidden = false
        AND c.text ~* v_tag_pattern
        AND p.visibility = 'public' AND p.deleted_at IS NULL
        AND (p.publish_at IS NULL OR p.publish_at <= now())
    ) INTO v_valid;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.author_page_post_comments c
      JOIN public.author_page_posts p ON p.id = c.post_id
      WHERE c.id = p_source_id AND c.user_id = p_sender_user_id
        AND c.post_id = p_post_id AND c.is_hidden = false
        AND c.deleted_at IS NULL AND p.status = 'active'
        AND c.text ~* v_tag_pattern
        AND (p_author_page_id IS NULL OR (
          p.author_page_id = p_author_page_id
          AND EXISTS (
            SELECT 1 FROM public.author_pages a
            WHERE a.id = p_author_page_id AND a.user_id = p_sender_user_id
              AND a.status = 'active'
          )
        ))
    ) INTO v_valid;
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'Mass mention source is not eligible';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_sender_user_id::text || ':' || p_tag, 0));
  SELECT j.id INTO v_id FROM public.mass_mention_jobs j
  WHERE j.sender_user_id = p_sender_user_id AND j.source_kind = p_source_kind
    AND j.source_id = p_source_id AND j.tag = p_tag;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'duplicate'::text;
    RETURN;
  END IF;

  v_limit := CASE WHEN p_tag = 'followers' THEN 1 ELSE 2 END;
  SELECT count(*) INTO v_total FROM public.mass_mention_jobs j
  WHERE j.sender_user_id = p_sender_user_id AND j.tag = p_tag
    AND j.created_at > now() - interval '24 hours';
  IF v_total >= v_limit THEN
    RETURN QUERY SELECT NULL::uuid, 'limited'::text;
    RETURN;
  END IF;

  INSERT INTO public.mass_mention_jobs (
    sender_user_id, source_kind, source_id, post_id, author_page_id, tag
  ) VALUES (
    p_sender_user_id, p_source_kind, p_source_id, p_post_id, p_author_page_id, p_tag
  ) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 'queued'::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_mention_claim_job()
RETURNS SETOF public.mass_mention_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH claim AS (
    SELECT j.id FROM public.mass_mention_jobs j
    WHERE (j.status = 'pending' AND j.available_at <= now())
      OR (j.status = 'processing' AND j.locked_at < now() - interval '3 minutes')
    ORDER BY j.available_at, j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.mass_mention_jobs j
  SET status = 'processing', locked_at = clock_timestamp(),
      attempts = j.attempts + 1, updated_at = clock_timestamp()
  FROM claim
  WHERE j.id = claim.id
  RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_mention_deliver_batch(
  p_job_id uuid,
  p_recipient_user_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.mass_mention_jobs%ROWTYPE;
  v_recipient uuid;
  v_preference text;
  v_follows boolean;
  v_digest public.mass_mention_digests%ROWTYPE;
  v_digest_id uuid;
  v_notice_id uuid;
  v_receipt uuid;
  v_sender_name text;
  v_link text;
  v_count integer := 0;
  v_active boolean;
  v_tag_pattern text;
BEGIN
  IF coalesce(array_length(p_recipient_user_ids, 1), 0) > 150 THEN
    RAISE EXCEPTION 'Mass mention batch too large';
  END IF;
  SELECT * INTO v_job FROM public.mass_mention_jobs j
    WHERE j.id = p_job_id AND j.status = 'processing'
      AND j.locked_at > now() - interval '3 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mass mention job is not leased';
  END IF;
  v_tag_pattern := CASE WHEN v_job.tag = 'followers'
    THEN '(^|[^A-Za-z0-9_@./])@followers?([^A-Za-z0-9_]|$)'
    ELSE '(^|[^A-Za-z0-9_@./])@highlight([^A-Za-z0-9_]|$)' END;
  IF v_job.source_kind = 'reader_post_comment' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.reader_post_comments c
      JOIN public.reader_posts p ON p.id = c.post_id
      WHERE c.id = v_job.source_id AND c.user_id = v_job.sender_user_id
        AND c.post_id = v_job.post_id AND c.is_hidden = false
        AND c.text ~* v_tag_pattern
        AND p.visibility = 'public' AND p.deleted_at IS NULL
        AND (p.publish_at IS NULL OR p.publish_at <= now())
    ) INTO v_active;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.author_page_post_comments c
      JOIN public.author_page_posts p ON p.id = c.post_id
      WHERE c.id = v_job.source_id AND c.user_id = v_job.sender_user_id
        AND c.post_id = v_job.post_id AND c.is_hidden = false
        AND c.deleted_at IS NULL AND c.text ~* v_tag_pattern
        AND p.status = 'active'
    ) INTO v_active;
  END IF;
  IF NOT v_active THEN RETURN 0; END IF;
  SELECT coalesce(nullif(u.name, ''), nullif(u.username, ''), 'Someone')
    INTO v_sender_name FROM public.users u WHERE u.id = v_job.sender_user_id;
  v_link := CASE WHEN v_job.source_kind = 'reader_post_comment'
    THEN '/reader/post/' || v_job.post_id::text
    ELSE '/author/page?post=' || v_job.post_id::text END;

  FOR v_recipient IN SELECT DISTINCT unnest(p_recipient_user_ids) ORDER BY 1 LOOP
    IF v_recipient IS NULL OR v_recipient = v_job.sender_user_id THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_recipient AND u.is_active = true) THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.chat_blocks b
      WHERE (b.blocker_user_id = v_recipient AND b.blocked_user_id = v_job.sender_user_id)
         OR (b.blocker_user_id = v_job.sender_user_id AND b.blocked_user_id = v_recipient)
    ) THEN CONTINUE; END IF;

    IF v_job.author_page_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.author_page_follows f
        WHERE f.author_page_id = v_job.author_page_id AND f.follower_user_id = v_recipient
      ) INTO v_follows;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.user_follows f
        WHERE f.following_user_id = v_job.sender_user_id AND f.follower_user_id = v_recipient
      ) INTO v_follows;
    END IF;
    IF NOT v_follows THEN CONTINUE; END IF;

    SELECT CASE WHEN v_job.tag = 'followers' THEN s.followers_mentions
                ELSE s.highlight_mentions END
      INTO v_preference
    FROM public.reader_tag_mention_settings s WHERE s.user_id = v_recipient;
    v_preference := coalesce(v_preference, 'everyone');
    IF v_preference = 'nobody' THEN CONTINUE; END IF;
    IF v_preference = 'following' AND NOT EXISTS (
      SELECT 1 FROM public.user_follows f
      WHERE f.follower_user_id = v_recipient AND f.following_user_id = v_job.sender_user_id
    ) THEN CONTINUE; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_job.sender_user_id::text || ':' || v_recipient::text, 0));
    INSERT INTO public.mass_mention_receipts (
      job_id, sender_user_id, recipient_user_id, source_kind, source_id
    ) VALUES (
      v_job.id, v_job.sender_user_id, v_recipient, v_job.source_kind, v_job.source_id
    ) ON CONFLICT (sender_user_id, recipient_user_id, source_kind, source_id) DO NOTHING
    RETURNING id INTO v_receipt;
    IF v_receipt IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_digest FROM public.mass_mention_digests d
    WHERE d.sender_user_id = v_job.sender_user_id AND d.recipient_user_id = v_recipient
      AND d.first_at > now() - interval '24 hours'
    ORDER BY d.first_at DESC LIMIT 1 FOR UPDATE;

    IF v_digest.id IS NULL THEN
      v_digest_id := gen_random_uuid();
      INSERT INTO public.notifications (
        user_id, type, title, message, image_url, link, reference_id, is_read
      ) VALUES (
        v_recipient, 'community', v_sender_name || ' mentioned you',
        'You were mentioned in a comment using @' || v_job.tag || '.',
        '', '/notifications?mass_mention_digest=' || v_digest_id::text, 'mass-mention:' || v_digest_id::text, false
      ) RETURNING id INTO v_notice_id;
      INSERT INTO public.mass_mention_digests (
        id, sender_user_id, recipient_user_id, notification_id, item_count, last_link
      ) VALUES (
        v_digest_id, v_job.sender_user_id, v_recipient, v_notice_id, 1, v_link
      );
    ELSE
      UPDATE public.mass_mention_digests d
      SET item_count = d.item_count + 1, last_at = now(), last_link = v_link
      WHERE d.id = v_digest.id;
      UPDATE public.notifications n
      SET message = 'You were mentioned in ' || (v_digest.item_count + 1)::text || ' comments from this account.',
          link = '/notifications?mass_mention_digest=' || v_digest.id::text, is_read = false, read_at = NULL
      WHERE n.id = v_digest.notification_id AND n.user_id = v_recipient AND n.deleted_at IS NULL;
    END IF;
    v_count := v_count + 1;
    v_receipt := NULL;
    v_digest.id := NULL;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mass_mention_enqueue_job(uuid, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mass_mention_claim_job() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mass_mention_deliver_batch(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mass_mention_enqueue_job(uuid, text, uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mass_mention_claim_job() TO service_role;
GRANT EXECUTE ON FUNCTION public.mass_mention_deliver_batch(uuid, uuid[]) TO service_role;

COMMIT;
