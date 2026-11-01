BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_redeem_featured_cards(
  p_event_id uuid, p_user_id uuid, p_episode_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_story_id text;
  v_balance record;
  v_episode record;
  v_active_id uuid;
  v_unlock_id uuid;
  v_redemption_id uuid;
  v_remaining integer;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_episode_id IS NULL THEN
    RAISE EXCEPTION 'Featured Story Card redemption requires event, user and episode'
      USING ERRCODE = '22023';
  END IF;

  SELECT w.featured_story_id INTO v_story_id
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id AND w.audience_group = 'kh';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown Featured Story Card event' USING ERRCODE = '22023';
  END IF;

  SELECT e.id, e.story_id, e.author_id, e.episode_number, e.title,
         e.status, e.deleted_at, e.is_locked, e.is_free_published
  INTO v_episode
  FROM public.episodes AS e
  WHERE e.id = p_episode_id AND e.story_id::text = v_story_id
  FOR SHARE;

  IF NOT FOUND OR v_episode.status IS DISTINCT FROM 'published'
     OR v_episode.deleted_at IS NOT NULL
     OR v_episode.is_locked IS DISTINCT FROM true
     OR v_episode.is_free_published IS TRUE THEN
    RAISE EXCEPTION 'Only a locked, published Featured Story episode can use Event Cards'
      USING ERRCODE = '22023';
  END IF;

  SELECT b.story_id, b.granted_cards, b.spent_cards
  INTO v_balance
  FROM public.shadow_read_event_featured_card_balances AS b
  WHERE b.event_id = p_event_id AND b.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_balance.story_id IS DISTINCT FROM v_story_id THEN
    RAISE EXCEPTION 'No Featured Story Card balance for this story'
      USING ERRCODE = '22023';
  END IF;

  v_remaining := v_balance.granted_cards - v_balance.spent_cards;

  SELECT u.id INTO v_active_id
  FROM public.episode_unlocks AS u
  WHERE u.user_id = p_user_id AND u.episode_id = p_episode_id
    AND u.unlock_status = 'active'
    AND (u.expires_at IS NULL OR u.expires_at > v_now)
  FOR UPDATE;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'unlocked', true, 'already_unlocked', true,
      'event_id', p_event_id, 'story_id', v_story_id,
      'episode_id', p_episode_id, 'cards_spent', 0, 'remaining_cards', v_remaining
    );
  END IF;

  IF v_remaining < 10 THEN
    RAISE EXCEPTION 'Ten Featured Story Cards are required'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.episode_unlocks AS u (
    user_id, story_id, episode_id, author_id,
    unlock_type, unlock_scope, access_type, expires_at,
    diamond_spent, unlock_status
  ) VALUES (
    p_user_id, v_episode.story_id, p_episode_id, v_episode.author_id,
    'story_card', 'single', 'permanent', NULL, 0, 'active'
  )
  ON CONFLICT (user_id, episode_id) DO UPDATE
    SET unlock_type = EXCLUDED.unlock_type,
        unlock_scope = EXCLUDED.unlock_scope,
        access_type = EXCLUDED.access_type,
        expires_at = NULL,
        diamond_spent = 0,
        unlock_status = 'active'
    WHERE u.unlock_status = 'active' AND u.expires_at <= v_now
  RETURNING u.id INTO v_unlock_id;

  IF v_unlock_id IS NULL THEN
    RAISE EXCEPTION 'Episode is already held or unavailable for redemption'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.shadow_read_event_featured_card_redemptions (
    event_id, user_id, story_id, episode_id, unlock_id, cards_spent
  ) VALUES (
    p_event_id, p_user_id, v_story_id, p_episode_id, v_unlock_id, 10
  ) RETURNING id INTO v_redemption_id;

  UPDATE public.shadow_read_event_featured_card_balances AS b
  SET spent_cards = b.spent_cards + 10,
      updated_at = v_now
  WHERE b.event_id = p_event_id AND b.user_id = p_user_id
    AND b.story_id = v_story_id
    AND b.granted_cards - b.spent_cards >= 10;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Featured Story Card balance changed during redemption';
  END IF;

  INSERT INTO public.episode_unlock_transactions (
    unlock_id, user_id, story_id, episode_id, author_id,
    currency, amount, transaction_type, metadata
  ) VALUES (
    v_unlock_id, p_user_id, v_episode.story_id, p_episode_id, v_episode.author_id,
    'story_card', 10, 'unlock',
    pg_catalog.jsonb_build_object(
      'source', 'shadow_read_event', 'event_id', p_event_id,
      'featured_story_id', v_story_id, 'card_redemption_id', v_redemption_id,
      'episode_number', v_episode.episode_number, 'episode_title', v_episode.title
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'unlocked', true, 'already_unlocked', false,
    'event_id', p_event_id, 'story_id', v_story_id,
    'episode_id', p_episode_id, 'unlock_id', v_unlock_id,
    'cards_spent', 10, 'remaining_cards', v_remaining - 10
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_redeem_featured_cards(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_redeem_featured_cards(uuid, uuid, uuid)
  TO service_role;

COMMIT;
