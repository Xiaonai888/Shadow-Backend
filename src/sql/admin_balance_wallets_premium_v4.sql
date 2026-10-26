SELECT public.get_admin_balance_wallets_v4(
  p_reader_tier => 'premium',
  p_limit => 20
)->'items' AS premium_readers;
