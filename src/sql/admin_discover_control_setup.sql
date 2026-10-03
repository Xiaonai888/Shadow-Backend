create table if not exists public.admin_discover_control_authors (
  author_page_id uuid primary key references public.author_pages(id) on delete cascade,
  added_by_admin_id text,
  added_by_admin_email text,
  created_at timestamptz not null default now()
);

create or replace function public.enforce_admin_discover_control_author_limit()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('admin_discover_control_authors_limit'));

  if exists (
    select 1
    from public.admin_discover_control_authors
    where author_page_id = new.author_page_id
  ) then
    return new;
  end if;

  if (
    select count(*)
    from public.admin_discover_control_authors
  ) >= 10 then
    raise exception 'Discover Control supports a maximum of 10 Author Pages';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_admin_discover_control_author_limit_trigger
on public.admin_discover_control_authors;

create trigger enforce_admin_discover_control_author_limit_trigger
before insert
on public.admin_discover_control_authors
for each row
execute function public.enforce_admin_discover_control_author_limit();

create index if not exists admin_discover_control_authors_created_idx
on public.admin_discover_control_authors(created_at desc);

alter table public.admin_discover_control_authors enable row level security;

revoke all
on public.admin_discover_control_authors
from public, anon, authenticated;

grant all
on public.admin_discover_control_authors
to service_role;
