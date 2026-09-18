do $$
begin
  if not exists (
    select 1
    from public.admin_permissions
    where permission_key = 'system_control.view'
  ) then
    insert into public.admin_permissions (
      permission_key,
      group_key,
      group_label,
      feature_key,
      feature_label,
      action,
      label,
      description,
      sort_order
    )
    values (
      'system_control.view',
      'alerts',
      'Alerts',
      'system_control',
      'System Control',
      'view',
      'View',
      'View System Control usage, anomalies, incidents, and provider telemetry.',
      (
        select coalesce(max(sort_order), 0) + 10
        from public.admin_permissions
      )
    );
  end if;

  if not exists (
    select 1
    from public.admin_permissions
    where permission_key = 'system_control.manage'
  ) then
    insert into public.admin_permissions (
      permission_key,
      group_key,
      group_label,
      feature_key,
      feature_label,
      action,
      label,
      description,
      sort_order
    )
    values (
      'system_control.manage',
      'alerts',
      'Alerts',
      'system_control',
      'System Control',
      'manage',
      'Manage',
      'Apply fixes, verify recovery, resolve incidents, and archive System Control incidents.',
      (
        select coalesce(max(sort_order), 0) + 10
        from public.admin_permissions
      )
    );
  end if;
end
$$;
