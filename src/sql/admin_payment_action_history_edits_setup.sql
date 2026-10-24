begin;

create table if not exists public.admin_payment_recovery_action_metadata (
  action_id uuid primary key references public.admin_payment_recovery_actions(id) on delete restrict,
  display_reference text not null check (char_length(display_reference) between 6 and 100),
  mark_note text not null default '' check (char_length(mark_note) <= 300),
  edit_count integer not null default 0 check (edit_count >= 0),
  updated_by_id text not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists admin_payment_recovery_metadata_reference_unique
  on public.admin_payment_recovery_action_metadata (upper(btrim(display_reference)));

create table if not exists public.admin_payment_recovery_action_edits (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.admin_payment_recovery_actions(id) on delete restrict,
  old_reference text not null,
  new_reference text not null,
  old_mark text not null,
  new_mark text not null,
  edit_number integer not null check (edit_number > 0),
  reason text not null check (char_length(reason) between 12 and 500),
  admin_id text not null,
  admin_email text not null,
  created_at timestamptz not null default now(),
  unique (action_id, edit_number)
);

create index if not exists admin_payment_recovery_edits_action_time_idx
  on public.admin_payment_recovery_action_edits (action_id, created_at desc, id desc);

alter table public.admin_payment_recovery_action_metadata enable row level security;
alter table public.admin_payment_recovery_action_edits enable row level security;

revoke all on public.admin_payment_recovery_action_metadata from public, anon, authenticated, service_role;
revoke all on public.admin_payment_recovery_action_edits from public, anon, authenticated, service_role;

grant select on public.admin_payment_recovery_action_metadata to service_role;
grant select on public.admin_payment_recovery_action_edits to service_role;

create or replace function public.admin_payment_recovery_edit_metadata_v1(
  p_action_id uuid,
  p_new_reference text,
  p_new_mark text,
  p_expected_edit_count integer,
  p_reason text,
  p_admin_id text,
  p_admin_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action record;
  v_metadata record;
  v_old_reference text;
  v_old_mark text;
  v_new_reference text;
  v_new_mark text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_admin_id text := btrim(coalesce(p_admin_id, ''));
  v_admin_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_edit_count integer := 0;
  v_edit_id uuid;
begin
  if p_action_id is null then
    raise exception 'A valid action ID is required';
  end if;
  if char_length(v_reason) < 12 or char_length(v_reason) > 500 then
    raise exception 'Edit reason must contain 12 to 500 characters';
  end if;
  if char_length(v_admin_id) < 2 or char_length(v_admin_email) < 5 then
    raise exception 'Admin identity is required';
  end if;

  select id, reference, payment_id into v_action
  from public.admin_payment_recovery_actions
  where id = p_action_id
  for update;

  if not found then
    raise exception 'Payment action was not found';
  end if;

  select display_reference, mark_note, edit_count into v_metadata
  from public.admin_payment_recovery_action_metadata
  where action_id = p_action_id
  for update;

  if found then
    v_old_reference := v_metadata.display_reference;
    v_old_mark := v_metadata.mark_note;
    v_edit_count := v_metadata.edit_count;
  else
    v_old_reference := v_action.reference;
    v_old_mark := '';
  end if;

  if p_expected_edit_count is distinct from v_edit_count then
    raise exception 'This action was updated by another admin. Refresh before editing';
  end if;

  v_new_reference := upper(btrim(coalesce(p_new_reference, v_old_reference)));
  v_new_mark := btrim(coalesce(p_new_mark, v_old_mark));

  if v_new_reference !~ '^[A-Z0-9][A-Z0-9._/-]{5,99}$' then
    raise exception 'Reference must contain 6 to 100 allowed characters';
  end if;
  if char_length(v_new_mark) > 300 then
    raise exception 'Mark note must contain at most 300 characters';
  end if;
  if v_new_reference = v_old_reference and v_new_mark = v_old_mark then
    raise exception 'No information was changed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-payment-display-reference:' || v_new_reference, 0));

  if exists (
    select 1
    from public.admin_payment_recovery_actions a
    left join public.admin_payment_recovery_action_metadata m on m.action_id = a.id
    where a.id <> p_action_id
      and (
        upper(btrim(a.reference)) = v_new_reference
        or upper(btrim(m.display_reference)) = v_new_reference
      )
  ) then
    raise exception 'Reference is already assigned to another payment action';
  end if;

  if exists (
    select 1
    from public.payment_transactions p
    where p.aba_trx_id is not null
      and upper(btrim(p.aba_trx_id)) = v_new_reference
      and (v_action.payment_id is null or p.id <> v_action.payment_id)
  ) then
    raise exception 'Reference is already assigned to another payment';
  end if;

  if exists (
    select 1
    from public.telegram_payments t
    where t.trx_id is not null
      and upper(btrim(t.trx_id)) = v_new_reference
      and t.matched_payment_id is not null
      and (v_action.payment_id is null or t.matched_payment_id <> v_action.payment_id)
  ) then
    raise exception 'Reference already matches another bank payment';
  end if;

  insert into public.admin_payment_recovery_action_metadata (
    action_id, display_reference, mark_note, edit_count,
    updated_by_id, updated_by_email, updated_at
  )
  values (
    p_action_id, v_new_reference, v_new_mark, v_edit_count + 1,
    v_admin_id, v_admin_email, now()
  )
  on conflict (action_id) do update
  set display_reference = excluded.display_reference,
      mark_note = excluded.mark_note,
      edit_count = excluded.edit_count,
      updated_by_id = excluded.updated_by_id,
      updated_by_email = excluded.updated_by_email,
      updated_at = excluded.updated_at;

  insert into public.admin_payment_recovery_action_edits (
    action_id, old_reference, new_reference, old_mark, new_mark,
    edit_number, reason, admin_id, admin_email
  )
  values (
    p_action_id, v_old_reference, v_new_reference, v_old_mark, v_new_mark,
    v_edit_count + 1, v_reason, v_admin_id, v_admin_email
  )
  returning id into v_edit_id;

  return jsonb_build_object(
    'ok', true,
    'action_id', p_action_id,
    'edit_id', v_edit_id,
    'display_reference', v_new_reference,
    'mark_note', v_new_mark,
    'edit_count', v_edit_count + 1,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.admin_payment_recovery_edit_metadata_v1(
  uuid, text, text, integer, text, text, text
) from public, anon, authenticated;

grant execute on function public.admin_payment_recovery_edit_metadata_v1(
  uuid, text, text, integer, text, text, text
) to service_role;

create or replace function public.prevent_payment_recovery_edit_history_changes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Payment action edit history is append-only';
  return null;
end;
$$;

revoke all on function public.prevent_payment_recovery_edit_history_changes()
  from public, anon, authenticated;

drop trigger if exists prevent_payment_recovery_edit_history_changes
  on public.admin_payment_recovery_action_edits;

create trigger prevent_payment_recovery_edit_history_changes
before update or delete on public.admin_payment_recovery_action_edits
for each row execute function public.prevent_payment_recovery_edit_history_changes();

commit;
