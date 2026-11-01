BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_featured_card_balances (
  event_id uuid NOT NULL REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  story_id text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(story_id)) BETWEEN 1 AND 128),
  granted_cards integer NOT NULL DEFAULT 0 CHECK (granted_cards >= 0),
  spent_cards integer NOT NULL DEFAULT 0 CHECK (spent_cards >= 0 AND spent_cards <= granted_cards),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT shadow_event_cards_participant_fk FOREIGN KEY (event_id, user_id)
    REFERENCES public.shadow_read_event_participants(event_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS shadow_event_featured_cards_reader_idx
  ON public.shadow_read_event_featured_card_balances(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_featured_card_grants (
  claim_id uuid PRIMARY KEY REFERENCES public.shadow_read_event_reward_claims(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  story_id text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(story_id)) BETWEEN 1 AND 128),
  card_amount integer NOT NULL CHECK (card_amount > 0 AND card_amount <= 1000),
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_event_card_grant_balance_fk FOREIGN KEY (event_id, user_id)
    REFERENCES public.shadow_read_event_featured_card_balances(event_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS shadow_event_featured_grants_reader_idx
  ON public.shadow_read_event_featured_card_grants(user_id, event_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS public.shadow_read_event_featured_card_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  story_id text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(story_id)) BETWEEN 1 AND 128),
  episode_id uuid NOT NULL,
  unlock_id uuid NOT NULL,
  cards_spent integer NOT NULL CHECK (cards_spent = 10),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_event_card_redemption_balance_fk FOREIGN KEY (event_id, user_id)
    REFERENCES public.shadow_read_event_featured_card_balances(event_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_event_card_one_episode_per_reader UNIQUE (user_id, episode_id)
);

CREATE INDEX IF NOT EXISTS shadow_event_card_redemptions_event_idx
  ON public.shadow_read_event_featured_card_redemptions(event_id, user_id, redeemed_at DESC);

ALTER TABLE public.shadow_read_event_featured_card_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_featured_card_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_read_event_featured_card_redemptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shadow_read_event_featured_card_balances FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.shadow_read_event_featured_card_grants FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.shadow_read_event_featured_card_redemptions FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.shadow_read_event_featured_card_balances TO service_role;
GRANT SELECT ON public.shadow_read_event_featured_card_grants TO service_role;
GRANT SELECT ON public.shadow_read_event_featured_card_redemptions TO service_role;

COMMIT;
