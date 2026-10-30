BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_on date NOT NULL UNIQUE,
  featured_story_id text NOT NULL CHECK (char_length(btrim(featured_story_id)) BETWEEN 1 AND 128),
  audience_group text NOT NULL DEFAULT 'kh' CHECK (audience_group = 'kh'),
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_read_event_week_cycle_check CHECK (
    starts_on >= DATE '2026-11-02' AND
    (starts_on - DATE '2026-11-02') % 28 = 0 AND
    EXTRACT(ISODOW FROM starts_on) = 1
  )
);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  day_number smallint NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 5),
  mission_type text NOT NULL CHECK (mission_type IN (
    'daily_story', 'free_read', 'read_new', 'read_update', 'read_completed',
    'read_genre', 'read_authors', 'reading_streak', 'task_coins', 'episode_marathon'
  )),
  story_id text,
  mission_params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mission_params) = 'object'),
  target_amount integer NOT NULL CHECK (target_amount BETWEEN 1 AND 10000),
  max_points integer NOT NULL CHECK (max_points BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_read_event_missions_slot_unique UNIQUE (event_id, day_number, slot),
  CONSTRAINT shadow_read_event_missions_composite_key UNIQUE (id, event_id, day_number),
  CONSTRAINT shadow_read_event_missions_story_rule CHECK (
    (slot = 1 AND mission_type = 'daily_story' AND story_id IS NOT NULL AND char_length(btrim(story_id)) BETWEEN 1 AND 128)
    OR (slot BETWEEN 2 AND 5 AND mission_type <> 'daily_story' AND story_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_read_event_unique_daily_story_idx
  ON public.shadow_read_event_missions (event_id, story_id)
  WHERE story_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_milestones (
  event_id uuid NOT NULL REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  day_number smallint NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  tier smallint NOT NULL CHECK (tier BETWEEN 1 AND 5),
  required_points integer NOT NULL CHECK (required_points > 0),
  coin_reward integer NOT NULL,
  PRIMARY KEY (event_id, day_number, tier),
  CONSTRAINT shadow_read_event_fixed_coin_rewards CHECK (
    (tier = 1 AND coin_reward = 25) OR
    (tier = 2 AND coin_reward = 50) OR
    (tier = 3 AND coin_reward = 75) OR
    (tier = 4 AND coin_reward = 100) OR
    (tier = 5 AND coin_reward = 150)
  )
);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_participants (
  event_id uuid NOT NULL REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reader_group_snapshot text NOT NULL CHECK (reader_group_snapshot = 'kh'),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS shadow_read_event_participants_user_idx
  ON public.shadow_read_event_participants (user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  day_number smallint NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  mission_id uuid,
  score_source text NOT NULL CHECK (score_source IN ('mission', 'unlock_bonus')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 160),
  points integer NOT NULL CHECK (points BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_read_event_score_participant_fk
    FOREIGN KEY (event_id, user_id)
    REFERENCES public.shadow_read_event_participants (event_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_read_event_score_mission_fk
    FOREIGN KEY (mission_id, event_id, day_number)
    REFERENCES public.shadow_read_event_missions (id, event_id, day_number) ON DELETE RESTRICT,
  CONSTRAINT shadow_read_event_score_source_rule CHECK (
    (score_source = 'mission' AND mission_id IS NOT NULL) OR
    (score_source = 'unlock_bonus' AND mission_id IS NULL)
  ),
  CONSTRAINT shadow_read_event_score_source_unique UNIQUE (event_id, user_id, source_key)
);

CREATE INDEX IF NOT EXISTS shadow_read_event_score_daily_idx
  ON public.shadow_read_event_score_events (event_id, day_number, user_id) INCLUDE (points);

CREATE INDEX IF NOT EXISTS shadow_read_event_score_overall_idx
  ON public.shadow_read_event_score_events (event_id, user_id) INCLUDE (points);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_reward_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reward_key text NOT NULL CHECK (char_length(reward_key) BETWEEN 1 AND 100),
  reward_type text NOT NULL CHECK (reward_type IN ('milestone', 'daily_top', 'overall_top', 'participation')),
  day_number smallint CHECK (day_number BETWEEN 1 AND 7),
  tier smallint CHECK (tier BETWEEN 1 AND 5),
  rank_number smallint CHECK (rank_number BETWEEN 1 AND 3),
  coin_amount integer NOT NULL DEFAULT 0 CHECK (coin_amount BETWEEN 0 AND 100000),
  voucher_amount integer NOT NULL DEFAULT 0 CHECK (voucher_amount BETWEEN 0 AND 1000),
  card_amount integer NOT NULL DEFAULT 0 CHECK (card_amount BETWEEN 0 AND 1000),
  card_story_id text,
  grant_status text NOT NULL DEFAULT 'pending' CHECK (grant_status IN ('pending', 'granted', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  granted_at timestamptz,
  CONSTRAINT shadow_read_event_reward_participant_fk
    FOREIGN KEY (event_id, user_id)
    REFERENCES public.shadow_read_event_participants (event_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_read_event_reward_unique UNIQUE (event_id, user_id, reward_key),
  CONSTRAINT shadow_read_event_reward_shape_check CHECK (
    (reward_type = 'milestone' AND day_number IS NOT NULL AND tier IS NOT NULL AND rank_number IS NULL) OR
    (reward_type = 'daily_top' AND day_number IS NOT NULL AND tier IS NULL AND rank_number IS NOT NULL) OR
    (reward_type = 'overall_top' AND day_number IS NULL AND tier IS NULL AND rank_number IS NOT NULL) OR
    (reward_type = 'participation' AND day_number IS NULL AND tier IS NULL AND rank_number IS NULL)
  ),
  CONSTRAINT shadow_read_event_reward_card_rule CHECK (
    (card_amount = 0 AND card_story_id IS NULL) OR
    (card_amount > 0 AND card_story_id IS NOT NULL AND char_length(btrim(card_story_id)) BETWEEN 1 AND 128)
  ),
  CONSTRAINT shadow_read_event_reward_grant_time CHECK (
    (grant_status = 'granted' AND granted_at IS NOT NULL) OR
    (grant_status <> 'granted' AND granted_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS shadow_read_event_claims_pending_idx
  ON public.shadow_read_event_reward_claims (event_id, created_at)
  WHERE grant_status = 'pending';

CREATE INDEX IF NOT EXISTS shadow_read_event_claims_user_idx
  ON public.shadow_read_event_reward_claims (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.shadow_read_event_validate_featured_story()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stories story
    WHERE story.id::text = NEW.featured_story_id
      AND story.status = 'published'
      AND story.deleted_at IS NULL
      AND lower(btrim(story.story_status)) = 'completed'
      AND COALESCE(story.total_episodes, 0) >= 10
  ) THEN
    RAISE EXCEPTION 'Featured Story must be published, completed, and have 10+ episodes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shadow_read_event_missions mission
    WHERE mission.event_id = NEW.id AND mission.story_id = NEW.featured_story_id
  ) THEN
    RAISE EXCEPTION 'Featured Story cannot be a daily mission story';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shadow_read_event_featured_story_guard ON public.shadow_read_event_weeks;
CREATE TRIGGER shadow_read_event_featured_story_guard
BEFORE INSERT OR UPDATE OF featured_story_id
ON public.shadow_read_event_weeks
FOR EACH ROW EXECUTE FUNCTION public.shadow_read_event_validate_featured_story();

CREATE OR REPLACE FUNCTION public.shadow_read_event_validate_daily_story()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.slot = 1 THEN
    IF EXISTS (
      SELECT 1 FROM public.shadow_read_event_weeks week
      WHERE week.id = NEW.event_id AND week.featured_story_id = NEW.story_id
    ) THEN
      RAISE EXCEPTION 'Daily mission story must differ from Featured Story';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.stories story
      WHERE story.id::text = NEW.story_id
        AND story.status = 'published' AND story.deleted_at IS NULL
        AND COALESCE(story.total_episodes, 0) >= 1
    ) THEN
      RAISE EXCEPTION 'Daily mission story must be available and published';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shadow_read_event_daily_story_guard ON public.shadow_read_event_missions;
CREATE TRIGGER shadow_read_event_daily_story_guard
BEFORE INSERT OR UPDATE OF event_id, slot, story_id
ON public.shadow_read_event_missions
FOR EACH ROW EXECUTE FUNCTION public.shadow_read_event_validate_daily_story();

REVOKE ALL ON FUNCTION public.shadow_read_event_validate_featured_story() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_read_event_validate_daily_story() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.shadow_read_event_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_reward_claims ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shadow_read_event_weeks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_read_event_missions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_read_event_milestones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_read_event_participants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_read_event_score_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_read_event_reward_claims FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_read_event_weeks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_read_event_missions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_read_event_milestones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_read_event_participants TO service_role;
GRANT SELECT, INSERT ON public.shadow_read_event_score_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.shadow_read_event_reward_claims TO service_role;

COMMIT;
