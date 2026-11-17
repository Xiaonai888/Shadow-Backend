BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_author_avatar_limit_100_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  active_count bigint;
BEGIN
  IF NEW.owner_type IS DISTINCT FROM 'author'
     OR NEW.category IS DISTINCT FROM 'author_page_avatar'
     OR NEW.asset_status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_type = 'author'
       AND OLD.category = 'author_page_avatar'
       AND OLD.asset_status = 'active'
       AND OLD.owner_id IS NOT DISTINCT FROM NEW.owner_id THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shadow:author-avatar:limit:' || NEW.owner_id::text, 0)
  );

  SELECT count(*)
  INTO active_count
  FROM public.r2_assets
  WHERE owner_type = 'author'
    AND owner_id = NEW.owner_id
    AND category = 'author_page_avatar'
    AND asset_status = 'active';

  IF active_count >= 100 THEN
    RAISE EXCEPTION 'Profile picture library is full. Remove an older picture first'
      USING ERRCODE = '23514', CONSTRAINT = 'shadow_author_avatar_max_100';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shadow_author_avatar_limit_100_before_write
ON public.r2_assets;

CREATE TRIGGER shadow_author_avatar_limit_100_before_write
BEFORE INSERT OR UPDATE OF owner_type, owner_id, category, asset_status
ON public.r2_assets
FOR EACH ROW
EXECUTE FUNCTION public.shadow_author_avatar_limit_100_guard();

COMMIT;

SELECT
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'r2_assets'
      AND t.tgname = 'shadow_author_avatar_limit_100_before_write'
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
  ) AS guard_enabled,
  (
    SELECT count(*)
    FROM (
      SELECT owner_id
      FROM public.r2_assets
      WHERE owner_type = 'author'
        AND category = 'author_page_avatar'
        AND asset_status = 'active'
      GROUP BY owner_id
      HAVING count(*) > 100
    ) AS over_limit
  ) AS authors_already_over_limit;
