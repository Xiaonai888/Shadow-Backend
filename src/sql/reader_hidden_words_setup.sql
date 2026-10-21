begin;

create table if not exists public.reader_hidden_words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  word text not null check (char_length(word) between 1 and 120),
  normalized_word text not null check (char_length(normalized_word) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (user_id, normalized_word)
);

create index if not exists reader_hidden_words_user_created_idx
  on public.reader_hidden_words (user_id, created_at desc);

alter table public.reader_hidden_words enable row level security;

revoke all on public.reader_hidden_words from public, anon, authenticated;
grant select, insert, delete on public.reader_hidden_words to service_role;

create or replace function public.reader_hidden_words_check_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 0));
  if (select count(*) from public.reader_hidden_words where user_id = new.user_id) >= 200 then
    raise exception 'Hidden words limit reached' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.reader_hidden_words_check_limit() from public, anon, authenticated;
grant execute on function public.reader_hidden_words_check_limit() to service_role;

drop trigger if exists reader_hidden_words_limit_trigger on public.reader_hidden_words;
create trigger reader_hidden_words_limit_trigger
  before insert on public.reader_hidden_words
  for each row execute function public.reader_hidden_words_check_limit();

commit;
