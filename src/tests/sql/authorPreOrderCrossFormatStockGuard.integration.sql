do $$
begin
  if current_database() <> 'preorder_guard_ci'
     or to_regprocedure('public.author_preorder_cross_format_stock_guard()') is null then
    raise exception 'PRE_ORDER_CI_GUARD_MISSING';
  end if;
end;
$$;

create function public.preorder_ci_expect_rejection(p_statement text, p_code text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_statement;
    raise exception 'PRE_ORDER_CI_EXPECTED_REJECTION_MISSING';
  exception when others then
    if sqlerrm is distinct from p_code then
      raise;
    end if;
  end;
end;
$$;

insert into public.author_preorder_books (
  id,standard_enabled,standard_quota,standard_reserved,
  limited_enabled,limited_quota,limited_reserved
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,10,3,true,4,0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true,4,0,false,4,0),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',false,20,0,true,3,0);

insert into public.author_preorder_stock_holds (
  order_id,book_id,edition,quantity,status
) values (
  '10000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','standard',4,'held'
);

insert into public.author_preorder_volume_holds (
  order_id,book_id,edition,quantity,status
) values (
  '20000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','standard',3,'held'
);

select public.preorder_ci_expect_rejection(
  $ci$insert into public.author_preorder_volume_holds
  (order_id,book_id,edition,quantity,status) values
  ('20000000-0000-4000-8000-000000000002',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','standard',1,'held')$ci$,
  'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'
);

select public.preorder_ci_expect_rejection(
  $ci$insert into public.author_preorder_stock_holds
  (order_id,book_id,edition,quantity,status) values
  ('10000000-0000-4000-8000-000000000002',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','standard',1,'held')$ci$,
  'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'
);

select public.preorder_ci_expect_rejection(
  $ci$update public.author_preorder_volume_holds set quantity=4
  where order_id='20000000-0000-4000-8000-000000000001'
    and book_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$ci$,
  'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'
);

update public.author_preorder_volume_holds
set quantity=3
where order_id='20000000-0000-4000-8000-000000000001'
  and book_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

insert into public.author_preorder_volume_holds (
  order_id,book_id,edition,quantity,status
) values (
  '20000000-0000-4000-8000-000000000003',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','standard',4,'held'
);

select public.preorder_ci_expect_rejection(
  $ci$insert into public.author_preorder_stock_holds
  (order_id,book_id,edition,quantity,status) values
  ('10000000-0000-4000-8000-000000000003',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','standard',1,'held')$ci$,
  'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'
);

select public.preorder_ci_expect_rejection(
  $ci$insert into public.author_preorder_volume_holds
  (order_id,book_id,edition,quantity,status) values
  ('20000000-0000-4000-8000-000000000004',
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc','standard',1,'held')$ci$,
  'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'
);

select public.preorder_ci_expect_rejection(
  $ci$insert into public.author_preorder_volume_holds
  (order_id,book_id,edition,quantity,status) values
  ('20000000-0000-4000-8000-000000000005',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd','standard',1,'held')$ci$,
  'PRE_ORDER_CROSS_FORMAT_BOOK_MISSING'
);

update public.author_preorder_volume_holds set status='consumed'
where order_id='20000000-0000-4000-8000-000000000001';
update public.author_preorder_books set standard_reserved=6
where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

do $$
declare
  v_total bigint;
  v_consumed integer;
begin
  select b.standard_reserved +
    (select coalesce(sum(quantity),0) from public.author_preorder_stock_holds h
     where h.book_id=b.id and h.edition='standard' and h.status='held') +
    (select coalesce(sum(quantity),0) from public.author_preorder_volume_holds h
     where h.book_id=b.id and h.edition='standard' and h.status='held')
  into v_total
  from public.author_preorder_books b
  where b.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  select count(*) into v_consumed from public.author_preorder_volume_holds
  where order_id='20000000-0000-4000-8000-000000000001' and status='consumed';

  if v_total <> 10 or v_consumed <> 1 then
    raise exception 'PRE_ORDER_CI_SETTLEMENT_INVARIANT_FAILED';
  end if;
end;
$$;

select 'PRE_ORDER_CI_SEQUENTIAL_STOCK_GUARD_PASSED' as result;
