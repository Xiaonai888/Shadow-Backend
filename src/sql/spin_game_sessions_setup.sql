create extension if not exists pgcrypto;

create table if not exists public.spin_game_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  request_key text not null,
  mode text not null check (mode in ('manual', 'reader', 'book', 'author')),
  cost_currency text check (cost_currency is null or cost_currency in ('coin', 'diamond', 'voucher')),
  cost_amount integer not null default 0 check (cost_amount >= 0),
  search_count integer not null default 0 check (search_count >= 0),
  search_limit integer not null default 0 check (search_limit >= 0),
  wallet_coin_after bigint,
  wallet_diamond_after bigint,
  wallet_voucher_after bigint,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique (user_id, request_key)
);

create index if not exists spin_game_sessions_user_started_idx
  on public.spin_game_sessions (user_id, started_at desc);

create index if not exists spin_game_sessions_user_mode_started_idx
  on public.spin_game_sessions (user_id, mode, started_at desc);

alter table public.spin_game_sessions enable row level security;

alter table public.spin_game_sessions
add column if not exists wallet_voucher_after bigint;

alter table public.spin_game_sessions
drop constraint if exists spin_game_sessions_cost_currency_check;

alter table public.spin_game_sessions
add constraint spin_game_sessions_cost_currency_check
check (
  cost_currency is null
  or cost_currency in ('coin', 'diamond', 'voucher')
);

alter table public.spin_game_sessions
alter column search_limit set default 0;

update public.spin_game_sessions
set search_limit = 0
where mode in ('reader', 'book', 'author')
  and expires_at > now()
  and search_limit <> 0;


revoke all on public.spin_game_sessions from anon, authenticated;
grant select, insert, update, delete on public.spin_game_sessions to service_role;

create or replace function public.get_spin_game_status(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_start timestamptz;
  v_reader integer := 0;
  v_book integer := 0;
  v_author integer := 0;
  v_total integer := 0;
  v_coin bigint := 0;
  v_diamond bigint := 0;
  v_voucher bigint := 0;
begin
  if p_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_USER_REQUIRED',
      'message', 'User is required'
    );
  end if;

  v_day_start :=
    date_trunc('day', timezone('Asia/Phnom_Penh', now()))
    at time zone 'Asia/Phnom_Penh';

  select
    count(*) filter (where mode = 'reader'),
    count(*) filter (where mode = 'book'),
    count(*) filter (where mode = 'author'),
    count(*) filter (where mode in ('reader', 'book', 'author'))
  into
    v_reader,
    v_book,
    v_author,
    v_total
  from public.spin_game_sessions
  where user_id = p_user_id
    and started_at >= v_day_start;

  select
    coalesce(gem_balance, 0)::bigint,
    coalesce(diamond_balance, 0)::bigint,
    coalesce(voucher_balance, 0)::bigint
  into
    v_coin,
    v_diamond,
    v_voucher
  from public.user_wallets
  where user_id = p_user_id
  limit 1;

  v_coin := coalesce(v_coin, 0);
  v_diamond := coalesce(v_diamond, 0);
  v_voucher := coalesce(v_voucher, 0);

  return jsonb_build_object(
    'ok', true,
    'day_start', v_day_start,
    'rules', jsonb_build_object(
      'manual', jsonb_build_object(
        'daily_limit', 100,
        'cost_currency', null,
        'cost_amount', 0,
        'tracking', 'local'
      ),
      'reader', jsonb_build_object(
        'daily_limit', 20,
        'cost_currency', 'coin',
        'cost_amount', 100
      ),
      'book', jsonb_build_object(
        'daily_limit', 20,
        'cost_currency', 'coin',
        'cost_amount', 100
      ),
      'author', jsonb_build_object(
        'daily_limit', 100,
        'cost_currency', 'voucher',
        'cost_amount', 10
      ),
      'shared', jsonb_build_object(
        'cooldown_every_games', 10,
        'cooldown_seconds', 120,
        'cooldown_tracking', 'local',
        'search_limit_per_game', null
      )
    ),
    'usage', jsonb_build_object(
      'manual', jsonb_build_object(
        'local', true,
        'limit', 100
      ),
      'reader', jsonb_build_object(
        'used', v_reader,
        'limit', 20,
        'remaining', greatest(0, 20 - v_reader)
      ),
      'book', jsonb_build_object(
        'used', v_book,
        'limit', 20,
        'remaining', greatest(0, 20 - v_book)
      ),
      'author', jsonb_build_object(
        'used', v_author,
        'limit', 100,
        'remaining', greatest(0, 100 - v_author)
      ),
      'total', v_total
    ),
    'cooldown', jsonb_build_object(
      'active', false,
      'wait_seconds', 0,
      'tracking', 'local'
    ),
    'wallet', jsonb_build_object(
      'coin_balance', v_coin,
      'diamond_balance', v_diamond,
      'voucher_balance', v_voucher
    )
  );
end;
$$;

create or replace function public.start_spin_game_session(
  p_user_id uuid,
  p_mode text,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_request_key text;
  v_day_start timestamptz;
  v_daily_used integer := 0;
  v_daily_limit integer := 0;
  v_cost integer := 0;
  v_currency text := null;
  v_search_limit integer := 0;
  v_coin bigint := 0;
  v_diamond bigint := 0;
  v_voucher bigint := 0;
  v_session public.spin_game_sessions%rowtype;
begin
  if p_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_USER_REQUIRED',
      'message', 'User is required'
    );
  end if;

  v_mode := lower(trim(coalesce(p_mode, '')));
  v_request_key := left(trim(coalesce(p_request_key, '')), 120);

  if v_mode = 'manual' then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_MANUAL_LOCAL',
      'message', 'Manual Spin games are local-only'
    );
  end if;

  if v_mode not in ('reader', 'book', 'author') then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_MODE_INVALID',
      'message', 'Invalid Spin game mode'
    );
  end if;

  if v_request_key = '' then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_REQUEST_KEY_REQUIRED',
      'message', 'Request key is required'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text, 0)
  );

  select *
  into v_session
  from public.spin_game_sessions
  where user_id = p_user_id
    and request_key = v_request_key
  limit 1;

  if found then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'session', jsonb_build_object(
        'id', v_session.id,
        'mode', v_session.mode,
        'cost_currency', v_session.cost_currency,
        'cost_amount', v_session.cost_amount,
        'search_count', v_session.search_count,
        'search_limit', v_session.search_limit,
        'wallet_coin_after', v_session.wallet_coin_after,
        'wallet_diamond_after', v_session.wallet_diamond_after,
        'wallet_voucher_after', v_session.wallet_voucher_after,
        'started_at', v_session.started_at,
        'expires_at', v_session.expires_at
      ),
      'status', public.get_spin_game_status(p_user_id)
    );
  end if;

  if v_mode = 'reader' then
    v_daily_limit := 20;
    v_cost := 100;
    v_currency := 'coin';
  elsif v_mode = 'book' then
    v_daily_limit := 20;
    v_cost := 100;
    v_currency := 'coin';
  else
    v_daily_limit := 100;
    v_cost := 10;
    v_currency := 'voucher';
  end if;

  v_day_start :=
    date_trunc('day', timezone('Asia/Phnom_Penh', now()))
    at time zone 'Asia/Phnom_Penh';

  select count(*)
  into v_daily_used
  from public.spin_game_sessions
  where user_id = p_user_id
    and mode = v_mode
    and started_at >= v_day_start;

  if v_daily_used >= v_daily_limit then
    return jsonb_build_object(
      'ok', false,
      'code', 'SPIN_DAILY_LIMIT',
      'message', 'Daily Spin game limit reached',
      'mode', v_mode,
      'used', v_daily_used,
      'limit', v_daily_limit,
      'remaining', 0,
      'status', public.get_spin_game_status(p_user_id)
    );
  end if;

  insert into public.user_wallets (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select
    coalesce(gem_balance, 0)::bigint,
    coalesce(diamond_balance, 0)::bigint,
    coalesce(voucher_balance, 0)::bigint
  into
    v_coin,
    v_diamond,
    v_voucher
  from public.user_wallets
  where user_id = p_user_id
  for update;

  if v_currency = 'coin' then
    if v_coin < v_cost then
      return jsonb_build_object(
        'ok', false,
        'code', 'INSUFFICIENT_COINS',
        'message', 'Not enough Coins',
        'price', v_cost,
        'need', greatest(0, v_cost - v_coin),
        'wallet', jsonb_build_object(
          'coin_balance', v_coin,
          'diamond_balance', v_diamond,
          'voucher_balance', v_voucher
        ),
        'status', public.get_spin_game_status(p_user_id)
      );
    end if;

    update public.user_wallets
    set
      gem_balance = coalesce(gem_balance, 0) - v_cost,
      updated_at = now()
    where user_id = p_user_id;

    v_coin := v_coin - v_cost;
  elsif v_currency = 'diamond' then
    if v_diamond < v_cost then
      return jsonb_build_object(
        'ok', false,
        'code', 'INSUFFICIENT_DIAMONDS',
        'message', 'Not enough Diamonds',
        'price', v_cost,
        'need', greatest(0, v_cost - v_diamond),
        'wallet', jsonb_build_object(
          'coin_balance', v_coin,
          'diamond_balance', v_diamond,
          'voucher_balance', v_voucher
        ),
        'status', public.get_spin_game_status(p_user_id)
      );
    end if;

    update public.user_wallets
    set
      diamond_balance = coalesce(diamond_balance, 0) - v_cost,
      updated_at = now()
    where user_id = p_user_id;

    v_diamond := v_diamond - v_cost;
  elsif v_currency = 'voucher' then
    if v_voucher < v_cost then
      return jsonb_build_object(
        'ok', false,
        'code', 'INSUFFICIENT_VOUCHERS',
        'message', 'Not enough Vouchers',
        'price', v_cost,
        'need', greatest(0, v_cost - v_voucher),
        'wallet', jsonb_build_object(
          'coin_balance', v_coin,
          'diamond_balance', v_diamond,
          'voucher_balance', v_voucher
        ),
        'status', public.get_spin_game_status(p_user_id)
      );
    end if;

    update public.user_wallets
    set
      voucher_balance = coalesce(voucher_balance, 0) - v_cost,
      updated_at = now()
    where user_id = p_user_id;

    v_voucher := v_voucher - v_cost;
  end if;

  insert into public.spin_game_sessions (
    user_id,
    request_key,
    mode,
    cost_currency,
    cost_amount,
    search_count,
    search_limit,
    wallet_coin_after,
    wallet_diamond_after,
    wallet_voucher_after,
    started_at,
    expires_at
  )
  values (
    p_user_id,
    v_request_key,
    v_mode,
    v_currency,
    v_cost,
    0,
    v_search_limit,
    v_coin,
    v_diamond,
    v_voucher,
    now(),
    now() + interval '24 hours'
  )
  returning *
  into v_session;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session', jsonb_build_object(
      'id', v_session.id,
      'mode', v_session.mode,
      'cost_currency', v_session.cost_currency,
      'cost_amount', v_session.cost_amount,
      'search_count', v_session.search_count,
      'search_limit', v_session.search_limit,
      'wallet_coin_after', v_session.wallet_coin_after,
      'wallet_diamond_after', v_session.wallet_diamond_after,
      'wallet_voucher_after', v_session.wallet_voucher_after,
      'started_at', v_session.started_at,
      'expires_at', v_session.expires_at
    ),
    'wallet', jsonb_build_object(
      'coin_balance', v_coin,
      'diamond_balance', v_diamond,
      'voucher_balance', v_voucher
    ),
    'status', public.get_spin_game_status(p_user_id)
  );
end;
$$;

revoke all on function public.get_spin_game_status(uuid)
from public, anon, authenticated;

revoke all on function public.start_spin_game_session(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.get_spin_game_status(uuid)
to service_role;

grant execute on function public.start_spin_game_session(uuid, text, text)
to service_role;

create or replace function public.consume_spin_search_request(
  p_user_id uuid,
  p_session_id uuid,
  p_expected_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected_mode text;
  v_session public.spin_game_sessions%rowtype;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'SPIN_USER_REQUIRED', 'message', 'User is required');
  end if;

  if p_session_id is null then
    return jsonb_build_object('ok', false, 'code', 'SPIN_SESSION_REQUIRED', 'message', 'Spin session is required');
  end if;

  v_expected_mode := lower(trim(coalesce(p_expected_mode, '')));

  if v_expected_mode not in ('reader', 'book', 'author') then
    return jsonb_build_object('ok', false, 'code', 'SPIN_SEARCH_MODE_INVALID', 'message', 'Invalid Spin search mode');
  end if;

  select *
  into v_session
  from public.spin_game_sessions
  where id = p_session_id
    and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SPIN_SESSION_NOT_FOUND', 'message', 'Spin session not found');
  end if;

  if v_session.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'SPIN_SESSION_EXPIRED', 'message', 'Spin session expired');
  end if;

  if v_session.mode <> v_expected_mode then
    return jsonb_build_object('ok', false, 'code', 'SPIN_SESSION_MODE_MISMATCH', 'message', 'Spin session does not match this search type');
  end if;

  if v_session.search_limit > 0 then
    if v_session.search_count >= v_session.search_limit then
      return jsonb_build_object(
        'ok', false,
        'code', 'SPIN_SEARCH_LIMIT',
        'message', 'Spin search limit reached',
        'used', v_session.search_count,
        'limit', v_session.search_limit,
        'remaining', 0
      );
    end if;

    update public.spin_game_sessions
    set search_count = search_count + 1
    where id = v_session.id
    returning *
    into v_session;
  end if;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session.id,
    'mode', v_session.mode,
    'used', v_session.search_count,
    'limit',
      case
        when v_session.search_limit > 0
          then v_session.search_limit
        else null
      end,
    'remaining',
      case
        when v_session.search_limit > 0
          then greatest(
            0,
            v_session.search_limit - v_session.search_count
          )
        else null
      end,
    'expires_at', v_session.expires_at
  );
end;
$$;

revoke all on function public.consume_spin_search_request(uuid, uuid, text)
from public, anon, authenticated;

grant execute on function public.consume_spin_search_request(uuid, uuid, text)
to service_role;
