create or replace function public.purchase_profile_frame_v1(
  p_user_id uuid,
  p_frame_id uuid,
  p_idempotency_key uuid
)
returns table (
  purchase_id uuid,
  charged boolean,
  purchase_currency text,
  amount integer,
  expires_at timestamptz,
  wallet_balance bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_frame public.profile_frames%rowtype;
  v_wallet public.user_wallets%rowtype;
  v_purchase public.reader_profile_frame_purchases%rowtype;
  v_price integer;
  v_balance bigint;
  v_now timestamptz := now();
begin
  if p_user_id is null or p_frame_id is null or p_idempotency_key is null then
    raise exception 'Invalid frame purchase request' using errcode = '22023';
  end if;

  select f.* into v_frame
  from public.profile_frames as f
  where f.id = p_frame_id and f.is_active = true
  for share;

  if not found or v_frame.access_tier not in ('coins', 'diamonds') then
    raise exception 'Frame is unavailable for purchase' using errcode = 'P0001';
  end if;

  select w.* into v_wallet
  from public.user_wallets as w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'Reader wallet not found' using errcode = 'P0001';
  end if;

  select p.* into v_purchase
  from public.reader_profile_frame_purchases as p
  where p.user_id = p_user_id and p.idempotency_key = p_idempotency_key;

  if found then
    if v_purchase.frame_id is distinct from p_frame_id then
      raise exception 'Purchase key belongs to another frame' using errcode = '22023';
    end if;
    return query select v_purchase.id, false, v_purchase.currency,
      v_purchase.amount, v_purchase.expires_at,
      case when v_purchase.currency = 'coins'
        then coalesce(v_wallet.gem_balance, 0)::bigint
        else coalesce(v_wallet.diamond_balance, 0)::bigint end;
    return;
  end if;

  select p.* into v_purchase
  from public.reader_profile_frame_purchases as p
  where p.user_id = p_user_id
    and p.frame_id = p_frame_id
    and p.currency = v_frame.access_tier
    and (p.currency = 'diamonds' or p.expires_at > v_now)
  order by p.purchased_at desc
  limit 1;

  if found then
    return query select v_purchase.id, false, v_purchase.currency,
      v_purchase.amount, v_purchase.expires_at,
      case when v_purchase.currency = 'coins'
        then coalesce(v_wallet.gem_balance, 0)::bigint
        else coalesce(v_wallet.diamond_balance, 0)::bigint end;
    return;
  end if;

  v_price := case when v_frame.access_tier = 'coins'
    then v_frame.coin_price else v_frame.diamond_price end;

  if v_price is null or v_price <= 0 then
    raise exception 'Frame price is invalid' using errcode = 'P0001';
  end if;

  update public.user_wallets as w
  set gem_balance = case when v_frame.access_tier = 'coins'
        then coalesce(w.gem_balance, 0) - v_price else w.gem_balance end,
      diamond_balance = case when v_frame.access_tier = 'diamonds'
        then coalesce(w.diamond_balance, 0) - v_price else w.diamond_balance end,
      updated_at = v_now
  where w.user_id = p_user_id
    and ((v_frame.access_tier = 'coins' and coalesce(w.gem_balance, 0) >= v_price)
      or (v_frame.access_tier = 'diamonds' and coalesce(w.diamond_balance, 0) >= v_price))
  returning case when v_frame.access_tier = 'coins'
    then w.gem_balance::bigint else w.diamond_balance::bigint end
  into v_balance;

  if not found then
    raise exception 'Insufficient frame purchase balance' using errcode = 'P0001';
  end if;

  insert into public.reader_profile_frame_purchases (
    user_id, frame_id, currency, amount, idempotency_key, purchased_at, expires_at
  ) values (
    p_user_id, p_frame_id, v_frame.access_tier, v_price, p_idempotency_key,
    v_now, case when v_frame.access_tier = 'coins'
      then v_now + interval '30 days' else null end
  ) returning * into v_purchase;

  return query select v_purchase.id, true, v_purchase.currency,
    v_purchase.amount, v_purchase.expires_at, v_balance;
end;
$function$;

revoke all on function public.purchase_profile_frame_v1(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_profile_frame_v1(uuid, uuid, uuid)
  to service_role;
