create table if not exists public.admin_payment_recovery_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null check (action_type in ('recovery', 'topup')),
  payment_id uuid references public.payment_transactions(id),
  user_id uuid not null references public.users(id),
  reference text not null,
  diamonds integer not null check (diamonds > 0),
  amount_usd numeric(12,2),
  bank_paid_at timestamptz,
  balance_before bigint not null,
  balance_after bigint not null,
  admin_id text not null,
  admin_email text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint admin_payment_recovery_payment_kind_check check (
    (action_type = 'recovery' and payment_id is not null)
    or (action_type = 'topup' and payment_id is null)
  )
);

create unique index if not exists admin_payment_recovery_action_payment_unique
  on public.admin_payment_recovery_actions (payment_id)
  where payment_id is not null;

create unique index if not exists admin_payment_recovery_action_reference_unique
  on public.admin_payment_recovery_actions (upper(btrim(reference)));

create index if not exists admin_payment_recovery_action_time_idx
  on public.admin_payment_recovery_actions (created_at desc);

create index if not exists admin_payment_recovery_user_history_idx
  on public.admin_payment_recovery_actions (user_id, created_at desc);

alter table public.admin_payment_recovery_actions enable row level security;
revoke all on public.admin_payment_recovery_actions from public, anon, authenticated;
grant select on public.admin_payment_recovery_actions to service_role;

create or replace function public.admin_payment_recovery_apply_v1(
  p_action text,
  p_payment_id uuid,
  p_user_id uuid,
  p_diamonds integer,
  p_reference text,
  p_verified_usd numeric,
  p_bank_paid_at timestamptz,
  p_admin_id text,
  p_admin_email text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reference text := upper(btrim(coalesce(p_reference, '')));
  v_note text := btrim(coalesce(p_note, ''));
  v_payment public.payment_transactions%rowtype;
  v_before bigint := 0;
  v_after bigint := 0;
  v_diamonds integer := 0;
  v_user_id uuid;
  v_action_id uuid;
  v_original_status text;
begin
  if v_action not in ('recovery', 'topup') then
    raise exception 'Invalid recovery action';
  end if;
  if length(v_reference) < 6 or length(v_reference) > 100 or v_reference !~ '^[A-Z0-9][A-Z0-9._/-]*$' then
    raise exception 'A unique ABA or adjustment reference (6-100 characters) is required';
  end if;
  if length(v_note) < 12 or length(v_note) > 500 then
    raise exception 'Enter a detailed reason (12-500 characters)';
  end if;
  if length(btrim(coalesce(p_admin_id, ''))) < 2 or length(btrim(coalesce(p_admin_email, ''))) < 5 then
    raise exception 'Admin identity is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-payment-reference:' || v_reference, 0));

  if exists (
    select 1 from public.admin_payment_recovery_actions a
    where upper(btrim(a.reference)) = v_reference
  ) then
    raise exception 'This bank or adjustment reference was already used';
  end if;

  if v_action = 'recovery' then
    if p_payment_id is null or p_user_id is null then
      raise exception 'Payment ID and recipient ID are required';
    end if;

    select * into v_payment from public.payment_transactions
    where id = p_payment_id for update;

    if not found then
      raise exception 'Payment order not found';
    end if;
    if v_payment.user_id is distinct from p_user_id then
      raise exception 'Payment does not belong to the selected account';
    end if;
    if coalesce(v_payment.payment_method, '') not in ('aba_payment_link', 'premium_aba_payment_link') then
      raise exception 'Only ABA payment-link orders may be recovered';
    end if;
    if lower(coalesce(v_payment.purchase_type, 'diamonds')) not in ('diamonds', 'premium') then
      raise exception 'Unsupported payment type';
    end if;
    if lower(coalesce(v_payment.status, '')) in ('success', 'approved', 'confirmed') or v_payment.released_at is not null then
      raise exception 'Payment is already marked released';
    end if;
    if lower(coalesce(v_payment.status, '')) not in ('waiting_payment', 'pending_review', 'callback_received', 'expired', 'cancelled') then
      raise exception 'This payment status is not eligible for recovery';
    end if;
    if p_bank_paid_at is null or p_bank_paid_at > now() + interval '5 minutes'
      or p_bank_paid_at < v_payment.created_at - interval '10 minutes'
      or p_bank_paid_at > v_payment.created_at + interval '7 days' then
      raise exception 'ABA payment time must match the selected order';
    end if;
    if p_verified_usd is null or p_verified_usd <= 0
      or p_verified_usd is distinct from coalesce(v_payment.amount_usd, v_payment.package_usd)
      or upper(coalesce(v_payment.currency, 'USD')) <> 'USD' then
      raise exception 'Verified bank amount does not match order';
    end if;
    if coalesce(v_payment.diamonds, 0) <= 0 or coalesce(v_payment.diamonds, 0) > 100000 then
      raise exception 'Invalid order diamond amount';
    end if;
    if v_payment.aba_trx_id is not null and btrim(v_payment.aba_trx_id) <> ''
      and upper(btrim(v_payment.aba_trx_id)) <> v_reference then
      raise exception 'Order already has a different ABA transaction reference';
    end if;
    if exists (
      select 1 from public.admin_payment_recovery_actions a
      where a.payment_id = p_payment_id
    ) then
      raise exception 'Order was already recovered';
    end if;
    v_diamonds := v_payment.diamonds;
    v_user_id := v_payment.user_id;
    v_original_status := v_payment.status;
  else
    if p_payment_id is not null or p_user_id is null then
      raise exception 'Manual top-up needs a recipient without a payment order';
    end if;
    if p_diamonds is null or p_diamonds < 1 or p_diamonds > 10000 then
      raise exception 'Manual top-up must be 1 to 10,000 Diamonds';
    end if;
    if not exists (select 1 from public.users where id = p_user_id) then
      raise exception 'Recipient account not found';
    end if;
    v_diamonds := p_diamonds;
    v_user_id := p_user_id;
  end if;

  if exists (
    select 1 from public.payment_transactions p
    where p.aba_trx_id is not null and upper(btrim(p.aba_trx_id)) = v_reference
      and (v_action = 'topup' or p.id <> p_payment_id)
  ) then
    raise exception 'ABA reference is assigned to another payment';
  end if;

  if exists (
    select 1 from public.telegram_payments t
    where upper(btrim(t.trx_id)) = v_reference
      and t.matched_payment_id is not null
      and (v_action = 'topup' or t.matched_payment_id <> p_payment_id)
  ) then
    raise exception 'ABA reference already matches another payment';
  end if;

  insert into public.user_wallets (user_id, diamond_balance, gem_balance, voucher_balance)
  values (v_user_id, 0, 0, 0)
  on conflict (user_id) do nothing;

  select coalesce(diamond_balance, 0) into v_before
  from public.user_wallets where user_id = v_user_id for update;

  if not found then
    raise exception 'Recipient wallet not found';
  end if;

  if v_action = 'recovery' then
    if v_original_status in ('expired', 'cancelled') then
      update public.payment_transactions
      set status = 'pending_review', updated_at = now()
      where id = p_payment_id;
    end if;

    if lower(coalesce(v_payment.purchase_type, 'diamonds')) = 'premium' then
      perform public.release_premium_payment_from_telegram(
        p_payment_id, null::uuid, v_reference, null::text, null::text
      );
    else
      perform public.admin_release_manual_payment(p_payment_id, p_admin_id, v_note);
    end if;

    select * into v_payment from public.payment_transactions
    where id = p_payment_id for update;

    if v_payment.status <> 'success' or v_payment.released_at is null then
      raise exception 'Payment release did not complete';
    end if;

    update public.payment_transactions
    set aba_trx_id = v_reference,
        paid_at = p_bank_paid_at,
        match_status = 'admin_bank_verified_recovery',
        match_reason = v_note,
        admin_reviewed_by = p_admin_id,
        admin_reviewed_at = now(),
        admin_note = v_note,
        updated_at = now()
    where id = p_payment_id;
  else
    update public.user_wallets
    set diamond_balance = coalesce(diamond_balance, 0) + v_diamonds,
        updated_at = now()
    where user_id = v_user_id;
  end if;

  select coalesce(diamond_balance, 0) into v_after
  from public.user_wallets where user_id = v_user_id;

  if v_after - v_before <> v_diamonds then
    raise exception 'Diamond balance change does not match the requested credit';
  end if;

  insert into public.admin_payment_recovery_actions (
    action_type, payment_id, user_id, reference, diamonds,
    amount_usd, bank_paid_at, balance_before, balance_after,
    admin_id, admin_email, reason
  ) values (
    v_action, p_payment_id, v_user_id, v_reference, v_diamonds,
    case when v_action = 'recovery' then p_verified_usd else null end,
    case when v_action = 'recovery' then p_bank_paid_at else null end,
    v_before, v_after, p_admin_id, p_admin_email, v_note
  ) returning id into v_action_id;

  return jsonb_build_object(
    'ok', true,
    'action_id', v_action_id,
    'action_type', v_action,
    'user_id', v_user_id,
    'order_id', case when v_action = 'recovery' then v_payment.order_id else null end,
    'diamonds', v_diamonds,
    'balance_before', v_before,
    'balance_after', v_after
  );
end;
$$;

revoke all on function public.admin_payment_recovery_apply_v1(text, uuid, uuid, integer, text, numeric, timestamptz, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_payment_recovery_apply_v1(text, uuid, uuid, integer, text, numeric, timestamptz, text, text, text)
  to service_role;
