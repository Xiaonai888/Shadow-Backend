-- NEW migration: Binance manual Diamond + admin-entered Voucher top-up.
-- Requires src/sql/admin_binance_usdt_credit_setup.sql and
-- src/sql/diamond_credit_popup_notices.sql to have been applied first.
-- Does NOT change existing received-USDT recovery credits (+100 vouchers).
begin;

-- The original table permits 0 or 100 vouchers only. Keep receipt credits
-- fixed at 100 while allowing a separately authorized manual amount.
alter table public.admin_binance_usdt_credit_actions
  drop constraint if exists admin_binance_usdt_credit_actions_bonus_vouchers_check;
alter table public.admin_binance_usdt_credit_actions
  drop constraint if exists admin_binance_credit_action_kind_check;
alter table public.admin_binance_usdt_credit_actions
  drop constraint if exists admin_binance_manual_voucher_amount_check;

alter table public.admin_binance_usdt_credit_actions
  add constraint admin_binance_manual_voucher_amount_check
  check (bonus_vouchers between 0 and 100000);

alter table public.admin_binance_usdt_credit_actions
  add constraint admin_binance_credit_action_kind_check
  check (
    (action_type = 'recovery' and transaction_id is not null
      and amount_usdt is not null and bonus_vouchers = 100)
    or
    (action_type = 'topup' and transaction_id is null
      and amount_usdt is null and bonus_vouchers between 0 and 100000)
  );

-- Manual-only RPC, separate from the immutable original recovery pipeline.
create or replace function public.admin_binance_manual_topup_v2(
  p_user_id uuid,
  p_reference text,
  p_diamonds integer,
  p_vouchers integer,
  p_admin_id text,
  p_admin_email text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text := upper(btrim(coalesce(p_reference, '')));
  v_note text := btrim(coalesce(p_note, ''));
  v_admin_id text := btrim(coalesce(p_admin_id, ''));
  v_admin_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_diamonds integer := p_diamonds;
  v_vouchers integer := p_vouchers;
  v_diamond_before bigint;
  v_diamond_after bigint;
  v_voucher_before bigint;
  v_voucher_after bigint;
  v_action_id uuid;
begin
  if p_user_id is null or not exists (
    select 1 from public.users where id = p_user_id
  ) then
    raise exception 'Recipient account not found';
  end if;
  if v_reference !~ '^[A-Z0-9][A-Z0-9._/-]{5,99}$' then
    raise exception 'A unique adjustment reference (6-100 characters) is required';
  end if;
  if v_diamonds is null or v_diamonds not between 1 and 10000 then
    raise exception 'Diamonds must be between 1 and 10000';
  end if;
  if v_vouchers is null or v_vouchers not between 0 and 100000 then
    raise exception 'Manual Vouchers must be between 0 and 100000';
  end if;
  if char_length(v_note) not between 12 and 500 then
    raise exception 'Enter a detailed credit reason (12-500 characters)';
  end if;
  if char_length(v_admin_id) < 2 or char_length(v_admin_email) < 5 then
    raise exception 'Admin identity is required';
  end if;

  -- Use the same lock namespace and reference checks as the existing v1 RPC.
  perform pg_advisory_xact_lock(hashtextextended('admin-payment-reference:' || v_reference, 0));

  if exists (
    select 1 from public.admin_binance_usdt_credit_actions a
    where upper(btrim(a.reference)) = v_reference
  ) then
    raise exception 'Binance adjustment reference was already credited';
  end if;
  if exists (
    select 1 from public.admin_payment_recovery_actions a
    where upper(btrim(a.reference)) = v_reference
  ) then
    raise exception 'Reference was already used for a Bank payment';
  end if;
  if exists (
    select 1 from public.payment_transactions p
    where p.aba_trx_id is not null and upper(btrim(p.aba_trx_id)) = v_reference
  ) then
    raise exception 'Reference is assigned to an existing payment order';
  end if;
  if exists (
    select 1 from public.telegram_payments t
    where t.matched_payment_id is not null and upper(btrim(t.trx_id)) = v_reference
  ) then
    raise exception 'Reference is assigned to another matched payment';
  end if;

  insert into public.user_wallets (user_id, diamond_balance, gem_balance, voucher_balance)
  values (p_user_id, 0, 0, 0)
  on conflict (user_id) do nothing;

  select coalesce(diamond_balance, 0), coalesce(voucher_balance, 0)
    into v_diamond_before, v_voucher_before
  from public.user_wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Recipient wallet not found';
  end if;

  update public.user_wallets
  set diamond_balance = coalesce(diamond_balance, 0) + v_diamonds,
      voucher_balance = coalesce(voucher_balance, 0) + v_vouchers,
      updated_at = now()
  where user_id = p_user_id;

  select coalesce(diamond_balance, 0), coalesce(voucher_balance, 0)
    into v_diamond_after, v_voucher_after
  from public.user_wallets where user_id = p_user_id;

  if v_diamond_after - v_diamond_before <> v_diamonds
    or v_voucher_after - v_voucher_before <> v_vouchers then
    raise exception 'Diamond or Voucher wallet change did not match the credit';
  end if;

  -- Existing append-only ledger and history screen use bonus_vouchers.
  insert into public.admin_binance_usdt_credit_actions (
    action_type, transaction_id, user_id, reference, amount_usdt,
    diamonds, bonus_vouchers, diamond_balance_before, diamond_balance_after,
    voucher_balance_before, voucher_balance_after, admin_id, admin_email, reason
  ) values (
    'topup', null, p_user_id, v_reference, null,
    v_diamonds, v_vouchers, v_diamond_before, v_diamond_after,
    v_voucher_before, v_voucher_after, v_admin_id, v_admin_email, v_note
  ) returning id into v_action_id;

  insert into public.reader_diamond_credit_notices (
    user_id, source_kind, source_id, diamonds, bonus_coins,
    bonus_vouchers, payment_method, created_at
  ) values (
    p_user_id, 'manual_topup', v_action_id, v_diamonds, 0,
    v_vouchers, 'binance_manual_topup', now()
  );

  return jsonb_build_object(
    'ok', true,
    'action_id', v_action_id,
    'action_type', 'topup',
    'user_id', p_user_id,
    'diamonds', v_diamonds,
    'bonus_vouchers', v_vouchers,
    'diamond_balance_before', v_diamond_before,
    'diamond_balance_after', v_diamond_after,
    'voucher_balance_before', v_voucher_before,
    'voucher_balance_after', v_voucher_after
  );
end;
$$;

revoke all on function public.admin_binance_manual_topup_v2(
  uuid, text, integer, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_binance_manual_topup_v2(
  uuid, text, integer, integer, text, text, text
) to service_role;

commit;
