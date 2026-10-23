BEGIN;

CREATE TABLE IF NOT EXISTS public.reader_chat_indicator_images (
  reader_id text PRIMARY KEY,
  id uuid UNIQUE,
  storage_key text,
  image_url text,
  mime_type text,
  file_size integer,
  width integer,
  height integer,
  pending_id uuid UNIQUE,
  pending_storage_key text,
  pending_mime_type text,
  pending_file_size integer,
  pending_token_hash text,
  pending_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reader_chat_indicator_owner_valid
    CHECK (reader_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  CONSTRAINT reader_chat_indicator_active_complete
    CHECK (num_nonnulls(id, storage_key, image_url, mime_type, file_size, width, height) IN (0, 7)),
  CONSTRAINT reader_chat_indicator_pending_complete
    CHECK (num_nonnulls(pending_id, pending_storage_key, pending_mime_type, pending_file_size, pending_token_hash, pending_expires_at) IN (0, 6)),
  CONSTRAINT reader_chat_indicator_active_type
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT reader_chat_indicator_pending_type
    CHECK (pending_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT reader_chat_indicator_active_bytes
    CHECK (file_size > 0 AND file_size <= 5242880),
  CONSTRAINT reader_chat_indicator_pending_bytes
    CHECK (pending_file_size > 0 AND pending_file_size <= 5242880),
  CONSTRAINT reader_chat_indicator_square
    CHECK (width BETWEEN 1 AND 512 AND height = width),
  CONSTRAINT reader_chat_indicator_url_valid
    CHECK (image_url LIKE 'https://%' AND length(image_url) <= 2048),
  CONSTRAINT reader_chat_indicator_active_key
    CHECK (storage_key = 'reader-chat-indicators/' || reader_id || '/' || id::text || '.' || CASE mime_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' END),
  CONSTRAINT reader_chat_indicator_pending_key
    CHECK (pending_storage_key = 'media-direct-temp/user/' || reader_id || '/chat-indicators/' || pending_id::text || '.' || CASE pending_mime_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' END),
  CONSTRAINT reader_chat_indicator_token_hash_valid
    CHECK (pending_token_hash ~ '^[a-f0-9]{64}$')
);

ALTER TABLE public.reader_chat_indicator_images ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.reader_chat_indicator_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reader_chat_indicator_images TO service_role;

COMMIT;
