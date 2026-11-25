BEGIN;

CREATE OR REPLACE FUNCTION public.task_center_smart_auto_action_v1(
  p_user_id uuid,
  p_mission_id uuid,
  p_story_id uuid,
  p_action text,
  p_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_now timestamptz;
  v_day date;
  v_day_start bigint;
  v_state public.task_center_smart_auto_state%ROWTYPE;
  v_entry jsonb;
  v_index integer;
  v_story_id uuid;
  v_template public.task_center_reading_missions%ROWTYPE;
  v_mode text;
  v_progress public.reader_reading_mission_progress%ROWTYPE;
  v_wallet public.user_wallets%ROWTYPE;
  v_history public.reader_reward_history%ROWTYPE;
  v_target integer;
  v_reward integer;
  v_seconds integer;
  v_status text;
  v_state_changed boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_mission_id IS NULL OR p_action IS NULL OR p_action NOT IN ('track','claim') THEN
    RAISE EXCEPTION 'Invalid Smart Auto action';
  END IF;
  IF p_action = 'track' AND (p_story_id IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 30) THEN
    RETURN jsonb_build_object('ok',false,'status',400,'message','Invalid reading progress');
  END IF;
  SELECT * INTO v_state FROM public.task_center_smart_auto_state
  WHERE reader_id = p_user_id::text FOR UPDATE;
  v_now := clock_timestamp();
  v_day := timezone('Asia/Phnom_Penh', v_now)::date;
  v_day_start := floor(extract(epoch FROM (v_day::timestamp AT TIME ZONE 'Asia/Phnom_Penh')) * 1000)::bigint;
  IF v_state.reader_id IS NULL OR v_state.day_start_ms <> v_day_start THEN
    RETURN jsonb_build_object('ok',false,'status',409,'message','Reading mission has changed. Open Task Center again.');
  END IF;

  SELECT item, (ordinality - 1)::integer INTO v_entry, v_index
  FROM jsonb_array_elements(v_state.missions) WITH ORDINALITY AS m(item, ordinality)
  WHERE item->>'slotId' = p_mission_id::text LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'status',404,'message','Reading mission not found');
  END IF;

  SELECT * INTO v_template FROM public.task_center_reading_missions
  WHERE id = p_mission_id AND is_active = true AND audience = (v_entry->>'audience');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'status',404,'message','Reading mission not found');
  END IF;
  SELECT CASE WHEN v_template.audience = 'international' THEN international_reading_mission_mode ELSE reading_mission_mode END
  INTO v_mode FROM public.task_center_settings WHERE setting_key = 'main';
  IF v_mode IS DISTINCT FROM 'smart_auto' THEN
    RETURN jsonb_build_object('ok',false,'status',409,'message','Reading mission mode has changed');
  END IF;

  v_story_id := (v_entry->>'storyId')::uuid;
  v_target := (v_entry->>'targetMinutes')::integer * 60;
  v_reward := (v_entry->>'rewardCoins')::integer;
  IF v_target IS NULL OR v_target NOT BETWEEN 60 AND 18000 OR v_reward IS NULL OR v_reward NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Invalid stored mission configuration';
  END IF;

  IF p_action = 'track' THEN
    IF p_story_id IS DISTINCT FROM v_story_id THEN
      RETURN jsonb_build_object('ok',false,'status',409,'message','Reading mission story has changed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.smart_ad_active_pool WHERE story_id = v_story_id) THEN
      RETURN jsonb_build_object('ok',false,'status',410,'message','This story is no longer available');
    END IF;
  END IF;

  SELECT * INTO v_progress FROM public.reader_reading_mission_progress
  WHERE user_id = p_user_id AND mission_id = p_mission_id FOR UPDATE;
  IF v_progress.id IS NOT NULL AND timezone('Asia/Phnom_Penh', v_progress.updated_at)::date IS DISTINCT FROM v_day THEN
    IF p_action = 'claim' THEN
      RETURN jsonb_build_object('ok',false,'status',400,'message','Reading mission is not completed yet');
    END IF;
    UPDATE public.reader_reading_mission_progress
    SET story_id = v_story_id, active_seconds = 0, completed_at = NULL, claimed_at = NULL, updated_at = v_now
    WHERE id = v_progress.id RETURNING * INTO v_progress;
  END IF;

  IF p_action = 'track' THEN
    IF v_progress.id IS NOT NULL AND (v_progress.active_seconds > 0 OR v_progress.completed_at IS NOT NULL OR v_progress.claimed_at IS NOT NULL)
       AND v_progress.story_id IS DISTINCT FROM v_story_id THEN
      RETURN jsonb_build_object('ok',false,'status',409,'message','Another story already has progress for this mission');
    END IF;
    IF v_progress.id IS NULL THEN
      INSERT INTO public.reader_reading_mission_progress(user_id,mission_id,story_id,active_seconds,created_at,updated_at)
      VALUES(p_user_id,p_mission_id,v_story_id,0,v_now,v_now)
      ON CONFLICT(user_id,mission_id) DO NOTHING;
      SELECT * INTO v_progress FROM public.reader_reading_mission_progress
      WHERE user_id = p_user_id AND mission_id = p_mission_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Mission progress not found'; END IF;
      IF (v_progress.active_seconds > 0 OR v_progress.completed_at IS NOT NULL OR v_progress.claimed_at IS NOT NULL) AND v_progress.story_id IS DISTINCT FROM v_story_id THEN
        RETURN jsonb_build_object('ok',false,'status',409,'message','Another story already has progress for this mission');
      END IF;
    END IF;
    IF v_progress.claimed_at IS NULL AND v_progress.completed_at IS NULL THEN
      v_seconds := least(v_target, greatest(0,coalesce(v_progress.active_seconds,0)) + p_seconds);
      UPDATE public.reader_reading_mission_progress
      SET story_id = v_story_id, active_seconds = v_seconds,
          completed_at = CASE WHEN v_seconds >= v_target THEN v_now ELSE NULL END,
          updated_at = v_now
      WHERE id = v_progress.id RETURNING * INTO v_progress;
    END IF;
    v_status := CASE WHEN v_progress.claimed_at IS NOT NULL THEN 'claimed' WHEN v_progress.completed_at IS NOT NULL OR v_progress.active_seconds >= v_target THEN 'claimable' ELSE 'in_progress' END;
    IF v_entry->>'status' IS DISTINCT FROM v_status THEN
      v_state_changed := true;
      UPDATE public.task_center_smart_auto_state
      SET missions = jsonb_set(missions,ARRAY[v_index::text,'status'],to_jsonb(v_status)),
          revision = revision + 1, updated_at = v_now WHERE reader_id = p_user_id::text;
    END IF;
    RETURN jsonb_build_object('ok',true,'progress',to_jsonb(v_progress),'state_changed',v_state_changed);
  END IF;

  IF v_progress.id IS NULL OR v_progress.story_id IS DISTINCT FROM v_story_id THEN
    RETURN jsonb_build_object('ok',false,'status',400,'message','Reading mission is not completed yet');
  END IF;
  IF v_progress.claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'status',400,'message','Reading mission already claimed','progress',to_jsonb(v_progress));
  END IF;
  IF v_progress.completed_at IS NULL AND v_progress.active_seconds < v_target THEN
    RETURN jsonb_build_object('ok',false,'status',400,'message','Reading mission is not completed yet','progress',to_jsonb(v_progress));
  END IF;

  UPDATE public.user_wallets
  SET gem_balance = coalesce(gem_balance,0) + v_reward, updated_at = v_now
  WHERE user_id = p_user_id RETURNING * INTO v_wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reader wallet not found'; END IF;

  UPDATE public.reader_reading_mission_progress
  SET claimed_at = v_now, updated_at = v_now WHERE id = v_progress.id RETURNING * INTO v_progress;

  INSERT INTO public.reader_reward_history(user_id,source_key,source_title,amount_gems,amount_vouchers,story_cards,metadata)
  VALUES(p_user_id,'reading_mission','Read ' || (v_entry->>'targetMinutes') || ' minutes',v_reward,0,0,
    jsonb_build_object('mission_id',p_mission_id,'story_link','/story/' || v_story_id::text,'target_minutes',(v_entry->>'targetMinutes')::integer,'active_seconds',v_progress.active_seconds,'coins',v_reward))
  RETURNING * INTO v_history;

  UPDATE public.task_center_smart_auto_state
  SET missions = jsonb_set(missions,ARRAY[v_index::text,'status'],to_jsonb('claimed'::text)),
      revision = revision + 1, updated_at = v_now WHERE reader_id = p_user_id::text;

  RETURN jsonb_build_object('ok',true,'progress',to_jsonb(v_progress),'wallet',to_jsonb(v_wallet),'history_item',to_jsonb(v_history),'reward_coins',v_reward);
END;
$$;

REVOKE ALL ON FUNCTION public.task_center_smart_auto_action_v1(uuid,uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.task_center_smart_auto_action_v1(uuid,uuid,uuid,text,integer) TO service_role;

COMMIT;
