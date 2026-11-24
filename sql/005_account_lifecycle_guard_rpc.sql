BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_reader_account_access(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
    SELECT p_user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id)
        AND NOT shadow_account_lifecycle.is_account_blocked(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.shadow_reader_account_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shadow_reader_account_access(uuid) TO service_role;

COMMIT;
