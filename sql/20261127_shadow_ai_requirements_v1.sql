begin;
create table if not exists public.shadow_ai_preorder_requirements (
  campaign_id uuid primary key references public.author_preorder_campaigns(id) on delete cascade,
  source_instruction text not null check (char_length(source_instruction) <= 300),
  rules jsonb not null check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) <= 35 and octet_length(rules::text) <= 8000),
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now()
);
alter table public.shadow_ai_preorder_requirements enable row level security;
revoke all on table public.shadow_ai_preorder_requirements from public, anon, authenticated;
grant select, insert, update, delete on table public.shadow_ai_preorder_requirements to service_role;
create or replace function public.shadow_ai_confirm_requirements_v1(
  p_campaign_id uuid, p_author_page_id uuid, p_owner_user_id uuid, p_source_instruction text, p_rules jsonb
) returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  c public.author_preorder_campaigns%rowtype;
begin
  if p_source_instruction is null or char_length(p_source_instruction) > 300 or p_rules is null
    or jsonb_typeof(p_rules) <> 'array' then return false; end if;
  if jsonb_array_length(p_rules) > 35 or octet_length(p_rules::text) > 8000 then return false; end if;
  select * into c from public.author_preorder_campaigns
    where id = p_campaign_id and author_page_id = p_author_page_id and owner_user_id = p_owner_user_id
    for update;
  if not found or c.status <> 'draft' or c.buyer_note_instruction is distinct from p_source_instruction then return false; end if;
  if not exists (select 1 from public.author_pages where id = p_author_page_id and user_id = p_owner_user_id and status = 'active') then return false; end if;
  insert into public.shadow_ai_preorder_requirements(campaign_id, source_instruction, rules, confirmed_by)
    values (p_campaign_id, p_source_instruction, p_rules, p_owner_user_id)
    on conflict (campaign_id) do update set source_instruction = excluded.source_instruction,
      rules = excluded.rules, confirmed_by = excluded.confirmed_by, confirmed_at = clock_timestamp();
  return true;
end;
$$;
revoke all on function public.shadow_ai_confirm_requirements_v1(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.shadow_ai_confirm_requirements_v1(uuid,uuid,uuid,text,jsonb) to service_role;
commit;
