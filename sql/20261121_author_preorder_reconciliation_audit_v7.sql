create table if not exists public.author_preorder_reconciliation_audit (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.author_preorder_orders(id) on delete restrict,
  event_key text not null,
  event_kind text not null,
  outcome text not null,
  reason_code text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (order_id, event_key),
  constraint author_preorder_audit_event_key_chk check (event_key ~ '^[a-z0-9:_-]{8,120}$'),
  constraint author_preorder_audit_kind_chk check (event_kind in ('reconciliation','finalization','expiry','review')),
  constraint author_preorder_audit_outcome_chk check (outcome in ('pending','verified','finalized','released','manual_review','failed','skipped')),
  constraint author_preorder_audit_reason_chk check (reason_code ~ '^PRE_ORDER_[A-Z0-9_]{3,80}$')
);

create index if not exists author_preorder_reconciliation_audit_order_idx
  on public.author_preorder_reconciliation_audit (order_id, created_at desc);

create index if not exists author_preorder_reconciliation_audit_time_idx
  on public.author_preorder_reconciliation_audit (created_at desc);

alter table public.author_preorder_reconciliation_audit enable row level security;

revoke all on table public.author_preorder_reconciliation_audit from public, anon, authenticated;
grant select, insert on table public.author_preorder_reconciliation_audit to service_role;

create or replace function public.author_preorder_reconciliation_audit_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'PRE_ORDER_RECONCILIATION_AUDIT_IMMUTABLE';
end;
$$;

revoke all on function public.author_preorder_reconciliation_audit_immutable() from public, anon, authenticated;

drop trigger if exists author_preorder_reconciliation_audit_immutable_trg
  on public.author_preorder_reconciliation_audit;

create trigger author_preorder_reconciliation_audit_immutable_trg
before update or delete on public.author_preorder_reconciliation_audit
for each row execute function public.author_preorder_reconciliation_audit_immutable();

create or replace function public.author_preorder_record_reconciliation_event(
  p_order_id uuid,
  p_event_key text,
  p_event_kind text,
  p_outcome text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.author_preorder_reconciliation_audit%rowtype;
  v_inserted boolean := false;
begin
  if p_order_id is null
     or p_event_key is null or p_event_key !~ '^[a-z0-9:_-]{8,120}$'
     or p_event_kind is null or p_event_kind not in ('reconciliation','finalization','expiry','review')
     or p_outcome is null or p_outcome not in ('pending','verified','finalized','released','manual_review','failed','skipped')
     or p_reason_code is null or p_reason_code !~ '^PRE_ORDER_[A-Z0-9_]{3,80}$' then
    raise exception 'PRE_ORDER_RECONCILIATION_AUDIT_INVALID';
  end if;

  if not exists (select 1 from public.author_preorder_orders where id = p_order_id) then
    raise exception 'PRE_ORDER_RECONCILIATION_ORDER_NOT_FOUND';
  end if;

  insert into public.author_preorder_reconciliation_audit (
    order_id, event_key, event_kind, outcome, reason_code
  ) values (
    p_order_id, p_event_key, p_event_kind, p_outcome, p_reason_code
  ) on conflict (order_id, event_key) do nothing
  returning * into v_row;

  if found then
    v_inserted := true;
  else
    select * into v_row
    from public.author_preorder_reconciliation_audit
    where order_id = p_order_id and event_key = p_event_key;
    if not found then
      raise exception 'PRE_ORDER_RECONCILIATION_AUDIT_CONFLICT';
    end if;
    if v_row.event_kind is distinct from p_event_kind
       or v_row.outcome is distinct from p_outcome
       or v_row.reason_code is distinct from p_reason_code then
      raise exception 'PRE_ORDER_RECONCILIATION_AUDIT_REPLAY_MISMATCH';
    end if;
  end if;

  return jsonb_build_object(
    'event_id', v_row.id,
    'order_id', v_row.order_id,
    'inserted', v_inserted,
    'created_at', v_row.created_at
  );
end;
$$;

revoke all on function public.author_preorder_record_reconciliation_event(uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.author_preorder_record_reconciliation_event(uuid,text,text,text,text)
  to service_role;
