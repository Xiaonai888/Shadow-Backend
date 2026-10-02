alter table public.users
  add column if not exists is_premium boolean not null default false,
  add column if not exists premium_started_at timestamptz,
  add column if not exists premium_expires_at timestamptz,
  add column if not exists premium_plan_months integer;

alter table public.payment_transactions
  add column if not exists purchase_type text not null default 'diamonds',
  add column if not exists premium_plan_months integer,
  add column if not exists premium_base_diamonds integer not null default 0,
  add column if not exists premium_bonus_diamonds integer not null default 0;

create index if not exists payment_transactions_purchase_type_status_idx
  on public.payment_transactions (purchase_type, status, created_at desc);

create index if not exists users_premium_expires_at_idx
  on public.users (premium_expires_at)
  where is_premium = true;

create or replace function public.release_premium_payment_from_telegram(
  p_payment_id uuid,
  p_telegram_payment_id uuid,
  p_trx_id text,
  p_apv text default null,
  p_payer_name text default null
)
returns public.payment_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payment_transactions%rowtype;
  v_now timestamptz := now();
  v_base_expiry timestamptz;
  v_new_expiry timestamptz;
begin
  select *
  into v_payment
  from public.payment_transactions
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Payment not found';
  end if;

  if coalesce(v_payment.purchase_type, 'diamonds') <> 'premium' then
    raise exception 'Payment is not a Premium order';
  end if;

  if coalesce(v_payment.premium_plan_months, 0) not in (1, 3, 12) then
    raise exception 'Invalid Premium plan';
  end if;

  if v_payment.status = 'success' then
    return v_payment;
  end if;

  if v_payment.status not in ('waiting_payment', 'pending_review', 'callback_received') then
    raise exception 'Payment cannot be released from status %', v_payment.status;
  end if;

  insert into public.user_wallets (
    user_id,
    diamond_balance,
    gem_balance,
    voucher_balance
  )
  values (
    v_payment.user_id,
    0,
    0,
    0
  )
  on conflict (user_id) do nothing;

  update public.user_wallets
  set
    diamond_balance = coalesce(diamond_balance, 0) + coalesce(v_payment.diamonds, 0),
    updated_at = v_now
  where user_id = v_payment.user_id;

  select
    case
      when is_premium = true
        and premium_expires_at is not null
        and premium_expires_at > v_now
      then premium_expires_at
      else v_now
    end
  into v_base_expiry
  from public.users
  where id = v_payment.user_id
  for update;

  if v_base_expiry is null then
    raise exception 'User not found';
  end if;

  v_new_expiry :=
    v_base_expiry +
    make_interval(months => v_payment.premium_plan_months);

  update public.users
  set
    is_premium = true,
    premium_started_at = coalesce(premium_started_at, v_now),
    premium_expires_at = v_new_expiry,
    premium_plan_months = v_payment.premium_plan_months,
    updated_at = v_now
  where id = v_payment.user_id;

  update public.payment_transactions
  set
    status = 'success',
    aba_trx_id = coalesce(nullif(trim(p_trx_id), ''), aba_trx_id),
    aba_apv = coalesce(nullif(trim(p_apv), ''), aba_apv),
    telegram_payment_id = coalesce(p_telegram_payment_id, telegram_payment_id),
    payer_name = coalesce(nullif(trim(p_payer_name), ''), payer_name),
    match_status = 'auto_released',
    match_reason = 'Premium payment matched and released.',
    paid_at = coalesce(paid_at, v_now),
    released_at = coalesce(released_at, v_now),
    updated_at = v_now
  where id = v_payment.id
  returning *
  into v_payment;

  return v_payment;
end;
$$;

revoke all on function public.release_premium_payment_from_telegram(uuid, uuid, text, text, text) from public;
grant execute on function public.release_premium_payment_from_telegram(uuid, uuid, text, text, text) to service_role;
