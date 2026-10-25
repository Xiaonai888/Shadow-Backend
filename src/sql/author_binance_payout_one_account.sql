begin;

do $$
begin
  if exists (
    select 1 from public.author_binance_payout_methods
    where nullif(btrim(binance_uid), '') is not null
    group by lower(btrim(binance_uid))
    having count(distinct author_id) > 1
  ) then
    raise exception 'Conflicting Binance UIDs already exist. Resolve duplicates before installing unique index.';
  end if;

  if exists (
    select 1 from public.author_binance_payout_methods
    where nullif(btrim(binance_pay_id), '') is not null
    group by lower(btrim(binance_pay_id))
    having count(distinct author_id) > 1
  ) then
    raise exception 'Conflicting Binance Pay IDs already exist. Resolve duplicates before installing unique index.';
  end if;
end;
$$;

create unique index if not exists author_binance_one_uid_per_account
  on public.author_binance_payout_methods (lower(btrim(binance_uid)))
  where nullif(btrim(binance_uid), '') is not null;

create unique index if not exists author_binance_one_payid_per_account
  on public.author_binance_payout_methods (lower(btrim(binance_pay_id)))
  where nullif(btrim(binance_pay_id), '') is not null;

commit;
