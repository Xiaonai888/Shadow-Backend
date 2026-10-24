begin;

create table if not exists public.reader_diamond_credit_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('payment', 'manual_topup')),
  source_id uuid not null,
  diamonds integer not null check (diamonds > 0),
  bonus_coins integer not null default 0 check (bonus_coins >= 0),
  bonus_vouchers integer not null default 0 check (bonus_vouchers >= 0),
  payment_method text not null default 'payway',
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (source_kind, source_id)
);

create index if not exists reader_diamond_credit_notices_pending_idx
  on public.reader_diamond_credit_notices (user_id, created_at, id)
  where seen_at is null;

alter table public.reader_diamond_credit_notices enable row level security;
revoke all on public.reader_diamond_credit_notices from public, anon, authenticated;
grant select, insert, update on public.reader_diamond_credit_notices to service_role;

create or replace function public.record_recovered_diamond_credit_notice_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_record public.payment_transactions%rowtype;
begin
  if new.action_type = 'topup' then
    insert into public.reader_diamond_credit_notices (
      user_id, source_kind, source_id, diamonds, bonus_coins, bonus_vouchers, payment_method, created_at
    ) values (
      new.user_id, 'manual_topup', new.id, new.diamonds, 0, 0, 'manual_topup', new.created_at
    ) on conflict (source_kind, source_id) do nothing;
    return new;
  end if;

  if new.action_type <> 'recovery' or new.payment_id is null then
    return new;
  end if;

  select * into payment_record
  from public.payment_transactions
  where id = new.payment_id;

  if not found
    or lower(coalesce(payment_record.purchase_type, 'diamonds')) <> 'diamonds'
    or lower(coalesce(payment_record.status, '')) <> 'success'
    or payment_record.released_at is null then
    return new;
  end if;

  insert into public.reader_diamond_credit_notices (
    user_id, source_kind, source_id, diamonds, bonus_coins, bonus_vouchers, payment_method, created_at
  ) values (
    payment_record.user_id,
    'payment',
    payment_record.id,
    payment_record.diamonds,
    greatest(0, coalesce(payment_record.bonus_gems, 0)),
    0,
    coalesce(payment_record.payment_method, 'payway'),
    coalesce(payment_record.released_at, now())
  ) on conflict (source_kind, source_id) do nothing;

  return new;
end;
$$;

revoke all on function public.record_recovered_diamond_credit_notice_v1() from public, anon, authenticated;

drop trigger if exists reader_diamond_credit_notice_from_recovery_v1 on public.admin_payment_recovery_actions;
create trigger reader_diamond_credit_notice_from_recovery_v1
after insert on public.admin_payment_recovery_actions
for each row
execute function public.record_recovered_diamond_credit_notice_v1();

create or replace function public.record_admin_released_diamond_notice_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.purchase_type, 'diamonds')) <> 'diamonds'
    or lower(coalesce(new.status, '')) <> 'success'
    or new.released_at is null
    or nullif(btrim(coalesce(new.admin_reviewed_by::text, '')), '') is null
    or (old.status is not distinct from new.status and old.released_at is not distinct from new.released_at) then
    return new;
  end if;

  insert into public.reader_diamond_credit_notices (
    user_id, source_kind, source_id, diamonds, bonus_coins, bonus_vouchers, payment_method, created_at
  ) values (
    new.user_id,
    'payment',
    new.id,
    new.diamonds,
    greatest(0, coalesce(new.bonus_gems, 0)),
    0,
    coalesce(new.payment_method, 'payway'),
    coalesce(new.released_at, now())
  ) on conflict (source_kind, source_id) do nothing;

  return new;
end;
$$;

revoke all on function public.record_admin_released_diamond_notice_v1() from public, anon, authenticated;

drop trigger if exists reader_diamond_credit_notice_from_admin_release_v1 on public.payment_transactions;
create trigger reader_diamond_credit_notice_from_admin_release_v1
after update on public.payment_transactions
for each row
execute function public.record_admin_released_diamond_notice_v1();

commit;
