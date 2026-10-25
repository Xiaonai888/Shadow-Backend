begin;

set local lock_timeout = '10s';

lock table public.author_binance_payout_methods in share row exclusive mode;

do $$
begin
  if exists (
    select 1
    from public.author_binance_payout_methods
    where binance_uid is not null
    group by upper(btrim(binance_uid))
    having count(*) > 1
  ) then
    raise exception 'Duplicate Binance UIDs exist in author payouts. Resolve them before enabling uniqueness.' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.author_binance_payout_methods
    where binance_pay_id is not null
    group by upper(btrim(binance_pay_id))
    having count(*) > 1
  ) then
    raise exception 'Duplicate Binance Pay IDs exist in author payouts. Resolve them before enabling uniqueness.' using errcode = '23505';
  end if;
end;
$$;

create unique index if not exists author_binance_payout_uid_unique
  on public.author_binance_payout_methods (upper(btrim(binance_uid)))
  where binance_uid is not null;

create unique index if not exists author_binance_payout_pay_id_unique
  on public.author_binance_payout_methods (upper(btrim(binance_pay_id)))
  where binance_pay_id is not null;

commit;
