BEGIN;

ALTER TABLE public.author_store_products
  ADD COLUMN IF NOT EXISTS pdf_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_update_note text NOT NULL DEFAULT '';

UPDATE public.author_store_products
SET pdf_version = 1,
    pdf_updated_at = COALESCE(updated_at, created_at, now())
WHERE lower(coalesce(product_type, '')) = 'pdf'
  AND pdf_version = 0
  AND (nullif(btrim(pdf_storage_key), '') IS NOT NULL
       OR nullif(btrim(pdf_file_url), '') IS NOT NULL);

CREATE OR REPLACE FUNCTION public.author_store_pdf_version_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  new_key text := nullif(btrim(NEW.pdf_storage_key), '');
  new_url text := nullif(btrim(NEW.pdf_file_url), '');
  file_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pdf_version := 0;
    NEW.pdf_updated_at := NULL;
    NEW.pdf_update_note := '';
    IF lower(coalesce(NEW.product_type, '')) = 'pdf'
       AND (new_key IS NOT NULL OR new_url IS NOT NULL) THEN
      NEW.pdf_version := 1;
      NEW.pdf_updated_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF lower(coalesce(NEW.product_type, '')) = 'pdf' THEN
    file_changed := (
      new_key IS NOT NULL
      AND new_key IS DISTINCT FROM nullif(btrim(OLD.pdf_storage_key), '')
    ) OR (
      new_key IS NULL
      AND new_url IS NOT NULL
      AND new_url IS DISTINCT FROM nullif(btrim(OLD.pdf_file_url), '')
    );
  END IF;

  IF file_changed THEN
    NEW.pdf_version := greatest(coalesce(OLD.pdf_version, 0), 0) + 1;
    NEW.pdf_updated_at := now();
    NEW.pdf_update_note := left(btrim(coalesce(NEW.pdf_update_note, '')), 500);
  ELSE
    NEW.pdf_version := OLD.pdf_version;
    NEW.pdf_updated_at := OLD.pdf_updated_at;
    NEW.pdf_update_note := OLD.pdf_update_note;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS author_store_pdf_version_v1 ON public.author_store_products;
CREATE TRIGGER author_store_pdf_version_v1
BEFORE INSERT OR UPDATE OF product_type, pdf_storage_key, pdf_file_url, pdf_version, pdf_updated_at, pdf_update_note
ON public.author_store_products
FOR EACH ROW EXECUTE FUNCTION public.author_store_pdf_version_v1();

COMMIT;

SELECT
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'author_store_products'
     AND column_name IN ('pdf_version', 'pdf_updated_at', 'pdf_update_note')) AS version_columns,
  EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.author_store_products'::regclass
            AND tgname = 'author_store_pdf_version_v1'
            AND tgenabled IN ('O', 'A') AND NOT tgisinternal) AS version_trigger_active,
  count(*) FILTER (WHERE pdf_version >= 1) AS versioned_pdfs,
  count(*) FILTER (WHERE pdf_version = 0 AND (nullif(btrim(pdf_storage_key), '') IS NOT NULL OR nullif(btrim(pdf_file_url), '') IS NOT NULL)) AS missing_versions
FROM public.author_store_products
WHERE lower(coalesce(product_type, '')) = 'pdf';
