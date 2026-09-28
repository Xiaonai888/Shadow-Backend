with corrected as (
  update public.author_earnings ae
  set
    created_at = eut.created_at,
    earning_month = to_char(
      eut.created_at at time zone 'Asia/Phnom_Penh',
      'YYYY-MM'
    ),
    updated_at = now()
  from public.episode_unlock_transactions eut
  where ae.unlock_transaction_id = eut.id
    and ae.currency = 'diamond'
    and ae.source_type = 'diamond_unlock'
    and eut.currency = 'diamond'
    and eut.transaction_type = 'unlock'
    and eut.created_at is not null
    and (
      ae.created_at is distinct from eut.created_at
      or ae.earning_month is distinct from to_char(
        eut.created_at at time zone 'Asia/Phnom_Penh',
        'YYYY-MM'
      )
    )
  returning ae.id
)
select count(*) as corrected_author_earnings
from corrected;
