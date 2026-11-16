CREATE TABLE IF NOT EXISTS public.chat_story_sticker_saved_packs (
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL REFERENCES public.sticker_folders(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, folder_id)
);

CREATE INDEX IF NOT EXISTS chat_story_sticker_saved_packs_user_order_idx
  ON public.chat_story_sticker_saved_packs (user_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.chat_story_sticker_favorites (
  user_id uuid NOT NULL,
  image_id uuid NOT NULL REFERENCES public.sticker_library(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, image_id)
);

CREATE INDEX IF NOT EXISTS chat_story_sticker_favorites_user_idx
  ON public.chat_story_sticker_favorites (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_story_sticker_recent (
  user_id uuid NOT NULL,
  image_id uuid NOT NULL REFERENCES public.sticker_library(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, image_id)
);

CREATE INDEX IF NOT EXISTS chat_story_sticker_recent_user_idx
  ON public.chat_story_sticker_recent (user_id, used_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_story_sticker_daily_unique (
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL REFERENCES public.sticker_folders(id) ON DELETE CASCADE,
  used_on date NOT NULL DEFAULT current_date,
  PRIMARY KEY (user_id, folder_id, used_on)
);

CREATE INDEX IF NOT EXISTS chat_story_sticker_daily_unique_date_idx
  ON public.chat_story_sticker_daily_unique (used_on);

CREATE TABLE IF NOT EXISTS public.chat_story_sticker_daily_stats (
  folder_id uuid NOT NULL REFERENCES public.sticker_folders(id) ON DELETE CASCADE,
  used_on date NOT NULL,
  unique_authors integer NOT NULL DEFAULT 0 CHECK (unique_authors >= 0),
  PRIMARY KEY (folder_id, used_on)
);

CREATE INDEX IF NOT EXISTS chat_story_sticker_daily_stats_date_idx
  ON public.chat_story_sticker_daily_stats (used_on DESC);

CREATE OR REPLACE VIEW public.chat_story_sticker_pack_catalog AS
SELECT f.id, f.name, f.icon, f.description, f.cover_image_url, f.sort_order,
  (SELECT count(*) FROM public.sticker_library i
    WHERE i.folder_id = f.id AND i.is_active IS TRUE)::integer AS image_count,
  (SELECT i.image_url FROM public.sticker_library i
    WHERE i.folder_id = f.id AND i.is_active IS TRUE
    ORDER BY i.sort_order ASC, i.created_at ASC, i.id ASC LIMIT 1) AS preview_url
FROM public.sticker_folders f
WHERE f.is_active IS TRUE;

CREATE OR REPLACE VIEW public.chat_story_sticker_trending_7d AS
SELECT folder_id, COALESCE(SUM(unique_authors), 0)::bigint AS score
FROM public.chat_story_sticker_daily_stats
WHERE used_on >= current_date - 6
GROUP BY folder_id;

CREATE OR REPLACE FUNCTION public.chat_story_record_sticker_use(p_user_id uuid, p_image_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_folder_id uuid;
  v_inserted integer;
BEGIN
  SELECT i.folder_id INTO v_folder_id
  FROM public.sticker_library i
  JOIN public.sticker_folders f ON f.id = i.folder_id
  WHERE i.id = p_image_id AND i.is_active IS TRUE AND f.is_active IS TRUE;

  IF v_folder_id IS NULL THEN
    RAISE EXCEPTION 'Sticker is not available';
  END IF;

  INSERT INTO public.chat_story_sticker_recent (user_id, image_id, used_at)
  VALUES (p_user_id, p_image_id, now())
  ON CONFLICT (user_id, image_id) DO UPDATE SET used_at = EXCLUDED.used_at;

  DELETE FROM public.chat_story_sticker_recent r
  WHERE r.user_id = p_user_id AND r.image_id NOT IN (
    SELECT image_id FROM public.chat_story_sticker_recent
    WHERE user_id = p_user_id
    ORDER BY used_at DESC, image_id
    LIMIT 48
  );

  INSERT INTO public.chat_story_sticker_daily_unique (user_id, folder_id, used_on)
  VALUES (p_user_id, v_folder_id, current_date)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    INSERT INTO public.chat_story_sticker_daily_stats (folder_id, used_on, unique_authors)
    VALUES (v_folder_id, current_date, 1)
    ON CONFLICT (folder_id, used_on)
    DO UPDATE SET unique_authors = public.chat_story_sticker_daily_stats.unique_authors + 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_story_record_sticker_use(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chat_story_record_sticker_use(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_story_record_sticker_use(uuid, uuid) TO service_role;

ALTER TABLE public.chat_story_sticker_saved_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_story_sticker_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_story_sticker_recent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_story_sticker_daily_unique ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_story_sticker_daily_stats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.chat_story_sticker_trending_7d FROM PUBLIC;
REVOKE ALL ON public.chat_story_sticker_trending_7d FROM anon, authenticated;
GRANT SELECT ON public.chat_story_sticker_trending_7d TO service_role;

REVOKE ALL ON public.chat_story_sticker_pack_catalog FROM PUBLIC;
REVOKE ALL ON public.chat_story_sticker_pack_catalog FROM anon, authenticated;
GRANT SELECT ON public.chat_story_sticker_pack_catalog TO service_role;
