BEGIN;

CREATE TABLE IF NOT EXISTS public.reader_profile_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reader_profile_photos_image_url_length CHECK (char_length(image_url) BETWEEN 10 AND 2048),
  CONSTRAINT reader_profile_photos_user_image_unique UNIQUE (user_id, image_url)
);

CREATE INDEX IF NOT EXISTS reader_profile_photos_user_recent_idx
ON public.reader_profile_photos (user_id, created_at DESC, id DESC);

ALTER TABLE public.reader_profile_photos ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.reader_profile_photos_enforce_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.reader_profile_photos
    WHERE user_id = NEW.user_id AND image_url = NEW.image_url
  ) THEN
    RETURN NEW;
  END IF;

  IF (
    SELECT count(*) FROM public.reader_profile_photos
    WHERE user_id = NEW.user_id
  ) >= 100 THEN
    RAISE EXCEPTION 'PHOTO_LIBRARY_FULL' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reader_profile_photos_capacity_guard ON public.reader_profile_photos;
CREATE TRIGGER reader_profile_photos_capacity_guard
BEFORE INSERT ON public.reader_profile_photos
FOR EACH ROW EXECUTE FUNCTION public.reader_profile_photos_enforce_limit();

INSERT INTO public.reader_profile_photos (user_id, image_url)
SELECT id, avatar_url
FROM public.users AS u
WHERE avatar_url ~ '^https://[^ ]+$'
  AND char_length(avatar_url) BETWEEN 10 AND 2048
  AND (SELECT count(*) FROM public.reader_profile_photos AS p WHERE p.user_id = u.id) < 100
ON CONFLICT (user_id, image_url) DO NOTHING;

COMMIT;
