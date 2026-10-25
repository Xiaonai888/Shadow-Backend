BEGIN;

ALTER TABLE public.stories
  ADD COLUMN IF NOT EXISTS create_request_id uuid;

ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS create_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS stories_user_create_request_id_unique
  ON public.stories (user_id, create_request_id)
  WHERE create_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS episodes_story_create_request_id_unique
  ON public.episodes (story_id, create_request_id)
  WHERE create_request_id IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
