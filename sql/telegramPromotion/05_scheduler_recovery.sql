begin;
create table if not exists public.telegram_promotion_recovery (
  language text primary key references public.telegram_promotion_settings(language),
  completed_through timestamptz,
  window_from timestamptz,
  window_to timestamptz,
  cursor_at timestamptz,
  cursor_id uuid,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  check ((window_from is null) = (window_to is null)),
  check ((cursor_at is null) = (cursor_id is null)),
  check (cursor_at is null or window_from is not null)
);
insert into public.telegram_promotion_recovery(language) select language from public.telegram_promotion_settings on conflict do nothing;
alter table public.telegram_promotion_recovery enable row level security;
revoke all on public.telegram_promotion_recovery from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_recovery to service_role;

create or replace function public.telegram_promotion_runtime_due_v1(p_language text)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
 'event_due_at', (select min(e.due_at) from public.telegram_promotion_events e where e.language=s.language and e.state='pending'),
 'queue_due_at', case when x.lease_at is not null then x.lease_at when x.ready_at is not null then greatest(s.next_send_at,x.ready_at) else null end,
 'update_waiting', exists(select 1 from public.telegram_promotion_queue q where q.language=s.language and q.kind='update' and q.status in ('ready','sending')),
 'update_ready', s.next_send_at<=now() and x.lease_at is null and exists(select 1 from public.telegram_promotion_queue q where q.language=s.language and q.kind='update' and q.status='ready' and q.attempts<5 and q.due_at<=now())
)
from public.telegram_promotion_settings s
cross join lateral (
 select min(q.lease_expires_at) filter(where q.status='sending') as lease_at,
 min(q.due_at) filter(where q.status='ready' and q.attempts<5 and (q.expires_at is null or q.expires_at>now())) as ready_at
 from public.telegram_promotion_queue q where q.language=s.language and q.status in ('ready','sending')
) x where s.language=p_language and s.enabled;
$$;
revoke all on function public.telegram_promotion_runtime_due_v1(text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_runtime_due_v1(text) to service_role;
commit;
