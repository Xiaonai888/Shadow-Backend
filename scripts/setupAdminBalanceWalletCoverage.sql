insert into public.user_wallets (user_id)
select u.id
from public.users u
where not exists (
  select 1
  from public.user_wallets w
  where w.user_id = u.id
);

create or replace function public.ensure_user_wallet_after_user_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_wallets (user_id)
  select new.id
  where not exists (
    select 1
    from public.user_wallets w
    where w.user_id = new.id
  );

  return new;
end;
$$;

drop trigger if exists users_ensure_wallet_after_insert
on public.users;

create trigger users_ensure_wallet_after_insert
after insert on public.users
for each row
execute function public.ensure_user_wallet_after_user_insert();
