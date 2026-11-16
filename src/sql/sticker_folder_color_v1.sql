ALTER TABLE public.sticker_folders
ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#6366F1';

UPDATE public.sticker_folders
SET color = '#6366F1'
WHERE color IS NULL OR color !~ '^#[0-9a-fA-F]{6}$';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sticker_folders_color_hex_check'
      AND conrelid = 'public.sticker_folders'::regclass
  ) THEN
    ALTER TABLE public.sticker_folders
    ADD CONSTRAINT sticker_folders_color_hex_check
    CHECK (color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END
$$;
