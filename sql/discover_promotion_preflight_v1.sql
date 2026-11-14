WITH required_objects (object_kind, object_name) AS (
  VALUES
    ('table', 'public.discover_promotion_language_rotation_v1'),
    ('function', 'public.get_or_rotate_discover_special_promotions_language_v1(text)'),
    ('function', 'public.get_or_rotate_discover_author_store_promotions_language_v1(text)'),
    ('table', 'public.stories'),
    ('table', 'public.episodes'),
    ('table', 'public.author_store_products'),
    ('table', 'public.author_pages'),
    ('table', 'public.platform_unlock_rules')
)
SELECT
  object_kind,
  object_name,
  CASE
    WHEN object_kind = 'function' THEN to_regprocedure(object_name) IS NOT NULL
    ELSE to_regclass(object_name) IS NOT NULL
  END AS installed
FROM required_objects
ORDER BY object_kind, object_name;

WITH required_columns (table_name, column_name) AS (
  VALUES
    ('stories', 'story_language'),
    ('stories', 'total_episodes'),
    ('stories', 'status'),
    ('stories', 'deleted_at'),
    ('episodes', 'story_id'),
    ('episodes', 'is_locked'),
    ('episodes', 'is_free_published'),
    ('episodes', 'first_published_at'),
    ('episodes', 'status'),
    ('episodes', 'deleted_at'),
    ('author_pages', 'status'),
    ('author_pages', 'admin_status'),
    ('author_pages', 'page_username'),
    ('author_store_products', 'product_type'),
    ('author_store_products', 'novel_type'),
    ('author_store_products', 'original_price'),
    ('author_store_products', 'sale_price'),
    ('author_store_products', 'status'),
    ('platform_unlock_rules', 'diamond_per_episode')
)
SELECT
  r.table_name,
  r.column_name,
  c.column_name IS NOT NULL AS installed
FROM required_columns r
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = r.table_name
 AND c.column_name = r.column_name
ORDER BY r.table_name, r.column_name;

SELECT
  p.proname AS function_name,
  p.prosecdef AS security_definer,
  pg_get_userbyid(p.proowner) AS function_owner,
  coalesce('search_path=public, pg_temp' = ANY(p.proconfig), false) AS expected_search_path,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_or_rotate_discover_special_promotions_language_v1',
    'get_or_rotate_discover_author_store_promotions_language_v1'
  )
ORDER BY p.proname;
