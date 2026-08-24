create or replace function public.reset_search_click_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.search_analytics_click_dedupe
  where group_id = new.group_id
    and search_type = new.search_type
    and searcher_hash = new.searcher_hash;

  return new;
end;
$$;

drop trigger if exists trg_reset_search_click_window
on public.search_analytics_recent_dedupe;

create trigger trg_reset_search_click_window
after insert or update of last_searched_at, expires_at
on public.search_analytics_recent_dedupe
for each row
execute function public.reset_search_click_window();

revoke all
on function public.reset_search_click_window()
from public, anon, authenticated;
