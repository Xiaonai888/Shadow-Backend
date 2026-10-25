begin;

insert into public.admin_permissions (
  permission_key, group_key, group_label, feature_key, feature_label,
  action, label, description, sort_order
)
select
  item.permission_key, 'app', 'App', 'admin_chat', 'Chat Center',
  item.action, item.label, item.description,
  coalesce((select max(sort_order) from public.admin_permissions), 0) + item.sort_order
from (values
  ('admin_chat.view', 'view', 'View', 'View support conversations and search Reader/Author accounts.', 10),
  ('admin_chat.reply', 'reply', 'Reply', 'Send support messages to assigned conversations.', 20),
  ('admin_chat.manage', 'manage', 'Manage', 'Archive, restore, update notes and priority in support chats.', 30),
  ('admin_chat.assign', 'assign', 'Assign', 'Assign and transfer support conversations to Admin staff.', 40)
) as item(permission_key, action, label, description, sort_order)
where not exists (
  select 1 from public.admin_permissions existing
  where existing.permission_key = item.permission_key
);

commit;
