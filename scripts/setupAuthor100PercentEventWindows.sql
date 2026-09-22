create table if not exists public.author_100_percent_event_windows (
  cycle_id uuid not null references public.author_100_percent_event_cycles(id) on delete restrict,
  author_id uuid not null references public.author_pages(id) on delete restrict,
  started_at timestamptz not null,
  ends_at timestamptz not null,
  primary key (cycle_id, started_at),
  constraint author_100_percent_window_dates_check check (ends_at >= started_at)
);

create index if not exists author_100_percent_event_windows_lookup_idx
  on public.author_100_percent_event_windows(author_id, started_at, ends_at);

alter table public.author_100_percent_event_windows enable row level security;
revoke all on public.author_100_percent_event_windows from public, anon, authenticated;
grant select, insert, update on public.author_100_percent_event_windows to service_role;

create or replace function public.record_author_100_percent_event_window()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entered_active boolean := false;
  v_ended_at timestamptz;
begin
  if new.status = 'active' then
    if tg_op = 'INSERT' then
      v_entered_active := true;
    else
      v_entered_active := old.status is distinct from 'active';
    end if;

    if v_entered_active then
      insert into public.author_100_percent_event_windows (
        cycle_id, author_id, started_at, ends_at
      ) values (
        new.id, new.author_id, new.last_resumed_at,
        new.last_resumed_at + new.remaining_seconds * interval '1 second'
      )
      on conflict (cycle_id, started_at) do update
      set ends_at = excluded.ends_at;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.status = 'active' and new.status in ('paused', 'completed') then
      v_ended_at := case
        when new.status = 'completed' then new.completed_at
        else new.last_paused_at
      end;

      update public.author_100_percent_event_windows as w
      set ends_at = greatest(w.started_at, least(w.ends_at, v_ended_at))
      where w.cycle_id = old.id
        and w.started_at = old.last_resumed_at;

      if not found then
        raise exception 'Missing active event window for cycle %', old.id;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists record_author_100_percent_event_window_trigger
  on public.author_100_percent_event_cycles;

create trigger record_author_100_percent_event_window_trigger
after insert or update of status
on public.author_100_percent_event_cycles
for each row
execute function public.record_author_100_percent_event_window();

insert into public.author_100_percent_event_windows (
  cycle_id, author_id, started_at, ends_at
)
select id, author_id, last_resumed_at,
  last_resumed_at + remaining_seconds * interval '1 second'
from public.author_100_percent_event_cycles
where status = 'active' and last_resumed_at is not null
on conflict (cycle_id, started_at) do nothing;

revoke all on function public.record_author_100_percent_event_window()
  from public, anon, authenticated;
