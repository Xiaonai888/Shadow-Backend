begin;

create table if not exists public.admin_binance_usdt_credit_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null check (action_type in ('recovery', 'topup')),
  transaction_id text references public.binance_usdt_alert_transactions(transaction_id),
  user_id uuid not null references public.users(id),
  reference text not null check (char_length(reference) between 1 and 128),
  amount_usdt numeric(28,8) check (amount_usdt is null or amount_usdt >= 1),
  diamonds integer not null check (diamonds between 1 and 10000),
  bonus_vouchers integer not null check (bonus_vouchers in (0, 100)),
  diamond_balance_before bigint not null,
  diamond_balance_after bigint not null,
  voucher_balance_before bigint not null,
  voucher_balance_after bigint not null,
  admin_id text not null,
  admin_email text not null,
  reason text not null check (char_length(reason) between 12 and 500),
  created_at timestamptz not null default now(),
  constraint admin_binance_credit_action_kind_check check (
    (action_type = 'recovery' and transaction_id is not null and amount_usdt is not null and bonus_vouchers = 100)
    or (action_type = 'topup' and transaction_id is null and amount_usdt is null and bonus_vouchers = 0)
  )
);

create unique index if not exists admin_binance_credit_transaction_unique
  on public.admin_binance_usdt_credit_actions (transaction_id)
  where transaction_id is not null;

create unique index if not exists admin_binance_credit_reference_unique
  on public.admin_binance_usdt_credit_actions (upper(btrim(reference)));

create index if not exists admin_binance_credit_history_idx
  on public.admin_binance_usdt_credit_actions (created_at desc, id desc);

create index if not exists admin_binance_credit_user_idx
  on public.admin_binance_usdt_credit_actions (user_id, created_at desc);

create table if not exists public.admin_binance_usdt_credit_action_metadata (
  action_id uuid primary key references public.admin_binance_usdt_credit_actions(id) on delete restrict,
  display_reference text not null check (char_length(display_reference) between 1 and 128),
  mark_note text not null default '' check (char_length(mark_note) <= 300),
  edit_count integer not null check (edit_count > 0),
  updated_by_id text not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists admin_binance_credit_display_reference_unique
  on public.admin_binance_usdt_credit_action_metadata (upper(btrim(display_reference)));

create table if not exists public.admin_binance_usdt_credit_action_edits (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.admin_binance_usdt_credit_actions(id) on delete restrict,
  old_reference text not null,
  new_reference text not null,
  old_mark text not null,
  new_mark text not null,
  edit_number integer not null check (edit_number > 0),
  reason text not null check (char_length(reason) between 12 and 500),
  admin_id text not null,
  admin_email text not null,
  created_at timestamptz not null default now(),
  unique (action_id, edit_number)
);

create index if not exists admin_binance_credit_action_edits_history_idx
  on public.admin_binance_usdt_credit_action_edits (action_id, edit_number desc);

alter table public.admin_binance_usdt_credit_actions enable row level security;
alter table public.admin_binance_usdt_credit_action_metadata enable row level security;
alter table public.admin_binance_usdt_credit_action_edits enable row level security;

revoke all on public.admin_binance_usdt_credit_actions from public, anon, authenticated;
revoke all on public.admin_binance_usdt_credit_action_metadata from public, anon, authenticated;
revoke all on public.admin_binance_usdt_credit_action_edits from public, anon, authenticated;

grant select on public.admin_binance_usdt_credit_actions to service_role;
grant select on public.admin_binance_usdt_credit_action_metadata to service_role;
grant select on public.admin_binance_usdt_credit_action_edits to service_role;

create or replace function public.block_admin_binance_credit_history_changes_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Financial credit and edit audit history are append-only';
end;
$$;

revoke all on function public.block_admin_binance_credit_history_changes_v1() from public, anon, authenticated;

drop trigger if exists admin_binance_credit_actions_immutable_v1 on public.admin_binance_usdt_credit_actions;
create trigger admin_binance_credit_actions_immutable_v1
before update or delete on public.admin_binance_usdt_credit_actions
for each row execute function public.block_admin_binance_credit_history_changes_v1();

drop trigger if exists admin_binance_credit_edits_immutable_v1 on public.admin_binance_usdt_credit_action_edits;
create trigger admin_binance_credit_edits_immutable_v1
before update or delete on public.admin_binance_usdt_credit_action_edits
for each row execute function public.block_admin_binance_credit_history_changes_v1();

create or replace function public.admin_binance_usdt_credit_apply_v1(
  p_action text,
  p_user_id uuid,
  p_transaction_id text,
  p_reference text,
  p_verified_usdt numeric,
  p_diamonds integer,
  p_admin_id text,
  p_admin_email text,
  p_note text,
  p_binance_verified boolean,
  p_recipient_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_transaction text := btrim(coalesce(p_transaction_id, ''));
  v_reference text;
  v_note text := btrim(coalesce(p_note, ''));
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_diamonds integer := coalesce(p_diamonds, 0);
  v_bonus integer := 0;
  v_usdt numeric(28,8) := null;
  v_diamond_before bigint := 0;
  v_diamond_after bigint := 0;
  v_voucher_before bigint := 0;
  v_voucher_after bigint := 0;
  v_action_id uuid;
begin
  if v_action not in ('recovery', 'topup') then
    raise exception 'Invalid Binance credit action';
  end if;
  if p_user_id is null or not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'Recipient account not found';
  end if;
  if v_diamonds < 1 or v_diamonds > 10000 then
    raise exception 'Diamonds must be between 1 and 10000';
  end if;
  if length(v_note) < 12 or length(v_note) > 500 then
    raise exception 'Enter a detailed credit reason (12-500 characters)';
  end if;
  if length(btrim(coalesce(p_admin_id, ''))) < 2 or length(btrim(coalesce(p_admin_email, ''))) < 5 then
    raise exception 'Admin identity is required';
  end if;
  if p_recipient_verified is distinct from true then
    raise exception 'Recipient account confirmation is required';
  end if;
  if v_action = 'recovery' and p_binance_verified is distinct from true then
    raise exception 'Official Binance receipt confirmation is required';
  end if;

  if v_action = 'recovery' then
    if v_transaction !~ '^[A-Za-z0-9_-]{1,128}$' or p_reference is not null and upper(btrim(p_reference)) <> upper(v_transaction) then
      raise exception 'Valid Binance transaction ID is required';
    end if;
    if p_verified_usdt is null or p_verified_usdt < 1 then
      raise exception 'Verified Binance receipt must be at least 1 USDT';
    end if;
    v_reference := upper(v_transaction);
    v_bonus := 100;
  else
    if nullif(v_transaction, '') is not null or p_verified_usdt is not null then
      raise exception 'Manual adjustment cannot claim a Binance receipt';
    end if;
    v_reference := upper(btrim(coalesce(p_reference, '')));
    if v_reference !~ '^[A-Z0-9][A-Z0-9._/-]{5,99}$' then
      raise exception 'Unique manual adjustment reference must contain 6-100 allowed characters';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-payment-reference:' || v_reference, 0));

  if exists (
    select 1 from public.admin_binance_usdt_credit_actions a
    where upper(btrim(a.reference)) = v_reference
      or (v_action = 'recovery' and a.transaction_id = v_transaction)
  ) then
    raise exception 'Binance receipt or adjustment reference was already credited';
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

  if v_action = 'recovery' then
    select * into v_receipt
    from public.binance_usdt_alert_transactions
    where transaction_id = v_transaction
    for update;
    if not found then
      raise exception 'Binance transaction was not recorded by the receiver';
    end if;
    if v_receipt.currency <> 'USDT' or v_receipt.amount is distinct from p_verified_usdt then
      raise exception 'Verified USDT amount does not match the official Binance receipt';
    end if;
    v_usdt := v_receipt.amount;
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
      voucher_balance = coalesce(voucher_balance, 0) + v_bonus,
      updated_at = now()
  where user_id = p_user_id;

  select coalesce(diamond_balance, 0), coalesce(voucher_balance, 0)
  into v_diamond_after, v_voucher_after
  from public.user_wallets
  where user_id = p_user_id;

  if v_diamond_after - v_diamond_before <> v_diamonds
    or v_voucher_after - v_voucher_before <> v_bonus then
    raise exception 'Diamond or Voucher wallet change did not match the credit';
  end if;

  insert into public.admin_binance_usdt_credit_actions (
    action_type, transaction_id, user_id, reference, amount_usdt,
    diamonds, bonus_vouchers, diamond_balance_before, diamond_balance_after,
    voucher_balance_before, voucher_balance_after, admin_id, admin_email, reason
  ) values (
    v_action, case when v_action = 'recovery' then v_transaction else null end,
    p_user_id, v_reference, v_usdt, v_diamonds, v_bonus,
    v_diamond_before, v_diamond_after, v_voucher_before, v_voucher_after,
    p_admin_id, lower(btrim(p_admin_email)), v_note
  ) returning id into v_action_id;

  insert into public.reader_diamond_credit_notices (
    user_id, source_kind, source_id, diamonds, bonus_coins,
    bonus_vouchers, payment_method, created_at
  ) values (
    p_user_id, 'manual_topup', v_action_id, v_diamonds, 0,
    v_bonus, case when v_action = 'recovery' then 'binance_pay' else 'binance_manual_topup' end, now()
  );

  return jsonb_build_object(
    'ok', true,
    'action_id', v_action_id,
    'action_type', v_action,
    'transaction_id', case when v_action = 'recovery' then v_transaction else null end,
    'user_id', p_user_id,
    'amount_usdt', v_usdt,
    'diamonds', v_diamonds,
    'bonus_vouchers', v_bonus,
    'diamond_balance_before', v_diamond_before,
    'diamond_balance_after', v_diamond_after,
    'voucher_balance_before', v_voucher_before,
    'voucher_balance_after', v_voucher_after
  );
end;
$$;

revoke all on function public.admin_binance_usdt_credit_apply_v1(text,uuid,text,text,numeric,integer,text,text,text,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.admin_binance_usdt_credit_apply_v1(text,uuid,text,text,numeric,integer,text,text,text,boolean,boolean)
  to service_role;

create or replace function public.admin_binance_usdt_credit_edit_v1(
  p_action_id uuid,
  p_new_reference text,
  p_new_mark text,
  p_expected_edit_count integer,
  p_reason text,
  p_admin_id text,
  p_admin_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.admin_binance_usdt_credit_actions%rowtype;
  v_metadata public.admin_binance_usdt_credit_action_metadata%rowtype;
  v_old_reference text;
  v_new_reference text;
  v_old_mark text;
  v_new_mark text;
  v_count integer;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_updated_at timestamptz := now();
begin
  if p_action_id is null then
    raise exception 'Credit action ID is required';
  end if;
  if length(v_reason) < 12 or length(v_reason) > 500 then
    raise exception 'Detailed edit reason must contain 12-500 characters';
  end if;
  if length(btrim(coalesce(p_admin_id, ''))) < 2 or length(btrim(coalesce(p_admin_email, ''))) < 5 then
    raise exception 'Admin identity is required';
  end if;
  if p_expected_edit_count is null or p_expected_edit_count < 0 then
    raise exception 'Current edit version is required';
  end if;

  select * into v_action
  from public.admin_binance_usdt_credit_actions
  where id = p_action_id
  for update;
  if not found then
    raise exception 'Credit action was not found';
  end if;

  select * into v_metadata
  from public.admin_binance_usdt_credit_action_metadata
  where action_id = p_action_id
  for update;

  v_count := coalesce(v_metadata.edit_count, 0);
  if v_count <> p_expected_edit_count then
    raise exception 'Another admin edited this credit action. Refresh first';
  end if;

  v_old_reference := coalesce(v_metadata.display_reference, v_action.reference);
  v_old_mark := coalesce(v_metadata.mark_note, '');
  v_new_reference := case
    when p_new_reference is null then v_old_reference
    else upper(btrim(p_new_reference))
  end;
  v_new_mark := case
    when p_new_mark is null then v_old_mark
    else btrim(p_new_mark)
  end;

  if v_new_reference !~ '^[A-Z0-9][A-Z0-9._/-]{0,127}$' or length(v_new_mark) > 300 then
    raise exception 'Invalid display reference or mark note';
  end if;
  if v_new_reference = v_old_reference and v_new_mark = v_old_mark then
    raise exception 'No information was changed';
  end if;

  if v_new_reference <> v_old_reference then
    perform pg_advisory_xact_lock(hashtextextended('admin-payment-reference:' || v_new_reference, 0));
    if exists (
      select 1 from public.admin_binance_usdt_credit_actions a
      where a.id <> p_action_id and upper(btrim(a.reference)) = v_new_reference
    ) or exists (
      select 1 from public.admin_binance_usdt_credit_action_metadata m
      where m.action_id <> p_action_id and upper(btrim(m.display_reference)) = v_new_reference
    ) or exists (
      select 1 from public.admin_payment_recovery_actions a
      where upper(btrim(a.reference)) = v_new_reference
    ) then
      raise exception 'Display reference is already assigned to another credit';
    end if;
  end if;

  insert into public.admin_binance_usdt_credit_action_metadata (
    action_id, display_reference, mark_note, edit_count,
    updated_by_id, updated_by_email, updated_at
  ) values (
    p_action_id, v_new_reference, v_new_mark, v_count + 1,
    p_admin_id, lower(btrim(p_admin_email)), v_updated_at
  ) on conflict (action_id) do update
  set display_reference = excluded.display_reference,
      mark_note = excluded.mark_note,
      edit_count = excluded.edit_count,
      updated_by_id = excluded.updated_by_id,
      updated_by_email = excluded.updated_by_email,
      updated_at = excluded.updated_at;

  insert into public.admin_binance_usdt_credit_action_edits (
    action_id, old_reference, new_reference, old_mark, new_mark,
    edit_number, reason, admin_id, admin_email
  ) values (
    p_action_id, v_old_reference, v_new_reference, v_old_mark, v_new_mark,
    v_count + 1, v_reason, p_admin_id, lower(btrim(p_admin_email))
  );

  return jsonb_build_object(
    'ok', true,
    'action_id', p_action_id,
    'display_reference', v_new_reference,
    'mark_note', v_new_mark,
    'edit_count', v_count + 1,
    'updated_at', v_updated_at
  );
end;
$$;

revoke all on function public.admin_binance_usdt_credit_edit_v1(uuid,text,text,integer,text,text,text)
  from public, anon, authenticated;
grant execute on function public.admin_binance_usdt_credit_edit_v1(uuid,text,text,integer,text,text,text)
  to service_role;

create or replace function public.reject_duplicate_bank_credit_reference_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.admin_binance_usdt_credit_actions b
    where upper(btrim(b.reference)) = upper(btrim(new.reference))
  ) then
    raise exception 'Reference was already credited through Binance';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_duplicate_bank_credit_reference_v1() from public, anon, authenticated;

drop trigger if exists reject_duplicate_bank_credit_reference_v1 on public.admin_payment_recovery_actions;
create trigger reject_duplicate_bank_credit_reference_v1
before insert on public.admin_payment_recovery_actions
for each row execute function public.reject_duplicate_bank_credit_reference_v1();

commit;
