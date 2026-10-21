begin;

alter table public.reader_post_comments
  add column if not exists moderation_status text not null default 'approved'
    check (moderation_status in ('approved', 'pending', 'rejected'));

alter table public.reader_post_comments
  add column if not exists moderated_at timestamptz;

alter table public.reader_post_comments
  add column if not exists moderated_by uuid references public.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.reader_post_comments'::regclass
      and conname = 'reader_post_comments_moderation_visibility_check'
  ) then
    alter table public.reader_post_comments
      add constraint reader_post_comments_moderation_visibility_check
      check (moderation_status = 'approved' or is_hidden is true);
  end if;
end;
$$;

create index if not exists reader_post_comments_pending_review_idx
  on public.reader_post_comments (post_id, created_at desc, id desc)
  where moderation_status = 'pending';

commit;
