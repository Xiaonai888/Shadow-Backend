CREATE INDEX IF NOT EXISTS smart_ad_reader_exposure_reader_recent_idx
ON public.smart_ad_reader_exposure (reader_hash, first_seen_at DESC)
INCLUDE (story_id);
