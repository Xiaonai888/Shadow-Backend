with target_functions(function_name) as (
  values
    ('generate_author_payouts'),
    ('record_author_story_payout_transfer'),
    ('mark_author_payout_paid'),
    ('get_author_story_payout_balance')
),
function_defs as (
  select
    'function'::text as section,
    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))::text as item,
    pg_get_functiondef(p.oid)::text as details
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select function_name from target_functions)
),
missing_functions as (
  select
    'missing_function'::text as section,
    tf.function_name::text as item,
    'No function with this name was found in public schema'::text as details
  from target_functions tf
  where not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = tf.function_name
  )
),
column_defs as (
  select
    'column'::text as section,
    format('%s.%s', c.table_name, c.column_name)::text as item,
    format('type=%s; nullable=%s; default=%s', c.udt_name, c.is_nullable, coalesce(c.column_default, '<none>'))::text as details
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name in (
      'author_payouts',
      'author_payment_methods',
      'author_binance_payout_methods',
      'reader_binance_account_bindings'
    )
),
constraint_defs as (
  select
    'constraint'::text as section,
    format('%s.%s', cl.relname, co.conname)::text as item,
    pg_get_constraintdef(co.oid, true)::text as details
  from pg_constraint co
  join pg_class cl on cl.oid = co.conrelid
  join pg_namespace ns on ns.oid = cl.relnamespace
  where ns.nspname = 'public'
    and cl.relname in (
      'author_payouts',
      'author_payment_methods',
      'author_binance_payout_methods',
      'reader_binance_account_bindings'
    )
),
index_defs as (
  select
    'index'::text as section,
    format('%s.%s', i.tablename, i.indexname)::text as item,
    i.indexdef::text as details
  from pg_indexes i
  where i.schemaname = 'public'
    and i.tablename in (
      'author_payouts',
      'author_payment_methods',
      'author_binance_payout_methods',
      'reader_binance_account_bindings'
    )
),
trigger_defs as (
  select
    'trigger'::text as section,
    format('%s.%s', cl.relname, tr.tgname)::text as item,
    pg_get_triggerdef(tr.oid, true)::text as details
  from pg_trigger tr
  join pg_class cl on cl.oid = tr.tgrelid
  join pg_namespace ns on ns.oid = cl.relnamespace
  where not tr.tgisinternal
    and ns.nspname = 'public'
    and cl.relname in (
      'author_payouts',
      'author_payment_methods',
      'author_binance_payout_methods',
      'reader_binance_account_bindings'
    )
)
select section, item, details
from (
  select * from function_defs
  union all select * from missing_functions
  union all select * from column_defs
  union all select * from constraint_defs
  union all select * from index_defs
  union all select * from trigger_defs
) as report
order by
  case section
    when 'function' then 1
    when 'missing_function' then 2
    when 'column' then 3
    when 'constraint' then 4
    when 'index' then 5
    when 'trigger' then 6
    else 7
  end,
  item;
