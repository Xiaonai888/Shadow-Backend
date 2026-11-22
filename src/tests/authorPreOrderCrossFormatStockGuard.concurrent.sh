#!/usr/bin/env bash
set -euo pipefail

: "${PGURL:?}"

current_db="$(psql -X -A -t -v ON_ERROR_STOP=1 "$PGURL" -c 'select current_database()')"
if [[ "$current_db" != 'preorder_guard_ci' ]]; then
  echo 'PRE_ORDER_CI_DATABASE_REQUIRED'
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -q "$PGURL" <<'SQL'
insert into public.author_preorder_books (
  id,standard_enabled,standard_quota,standard_reserved,
  limited_enabled,limited_quota,limited_reserved
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',true,1,0,false,0,0
);
SQL

workdir="$(mktemp -d)"
first_pid=''
cleanup() {
  if [[ -n "$first_pid" ]]; then
    kill "$first_pid" 2>/dev/null || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

export PREORDER_CI_READY="$workdir/first_inserted"
(
  psql -X -v ON_ERROR_STOP=1 -q "$PGURL" <<'SQL'
begin;
insert into public.author_preorder_stock_holds (
  order_id,book_id,edition,quantity,status
) values (
  '30000000-0000-4000-8000-000000000001',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standard',1,'held'
);
\! touch "$PREORDER_CI_READY"
select pg_sleep(3);
commit;
SQL
) > "$workdir/first.log" 2>&1 &
first_pid=$!

for (( attempt=0; attempt<100; attempt++ )); do
  if [[ -f "$PREORDER_CI_READY" ]]; then
    break
  fi
  if ! kill -0 "$first_pid" 2>/dev/null; then
    cat "$workdir/first.log"
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$PREORDER_CI_READY" ]]; then
  echo 'PRE_ORDER_CI_FIRST_TRANSACTION_NOT_READY'
  cat "$workdir/first.log"
  exit 1
fi

if psql -X -v ON_ERROR_STOP=1 -q "$PGURL" <<'SQL' > "$workdir/second.log" 2>&1
insert into public.author_preorder_volume_holds (
  order_id,book_id,edition,quantity,status
) values (
  '30000000-0000-4000-8000-000000000002',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standard',1,'held'
);
SQL
then
  echo 'PRE_ORDER_CI_OVERBOOKING_WAS_ACCEPTED'
  exit 1
fi

wait "$first_pid"
first_pid=''
if ! grep -Fq 'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED' "$workdir/second.log"; then
  cat "$workdir/second.log"
  echo 'PRE_ORDER_CI_UNEXPECTED_CONCURRENT_FAILURE'
  exit 1
fi

count="$(psql -X -A -t -v ON_ERROR_STOP=1 "$PGURL" -c "select (select count(*) from public.author_preorder_stock_holds where book_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' and status='held') + (select count(*) from public.author_preorder_volume_holds where book_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' and status='held')")"
if [[ "$count" != '1' ]]; then
  echo 'PRE_ORDER_CI_CONCURRENT_FINAL_COUNT_INVALID'
  exit 1
fi

echo 'PRE_ORDER_CI_CONCURRENT_STOCK_GUARD_PASSED'
