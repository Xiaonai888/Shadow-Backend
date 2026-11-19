ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS author_note text;

COMMENT ON COLUMN public.episodes.author_note IS
  'Optional author message for this episode only, up to 500 Unicode grapheme clusters; validated by the episode API.';
