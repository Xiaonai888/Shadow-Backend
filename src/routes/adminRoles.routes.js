import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getAdminActor, logAdminActivity } from '../services/adminActivity.service.js'

const router = express.Router()
const viewRoles = requireAdminPermission('roles.view')
const manageRoles = requireAdminPermission('roles.manage')

const OWNER_ONLY_PERMISSION_KEYS = new Set([
  'roles.manage',
  'admin_guard.manage',
  'admin_settings.manage',
])

function requireOwner(req, res, next) {
  const role = String(req.admin?.role || '').trim().toLowerCase()

  if (role !== 'owner') {
    return res.status(403).json({
      ok: false,
      message: 'Owner access required',
    })
  }

  return next()
}

function cleanText(value, maxLength = 300) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanPermissionKeys(value) {
  if (!Array.isArray(value)) return []

  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ),
  ]
}

function isReservedRoleName(name) {
  return cleanText(name, 60).toLowerCase() === 'owner'
}

function groupPermissions(permissions) {
  const groups = new Map()

  for (const permission of permissions) {
    if (!groups.has(permission.group_key)) {
      groups.set(permission.group_key, {
        key: permission.group_key,
        label: permission.group_label,
        features: new Map(),
      })
    }

    const group = groups.get(permission.group_key)

    if (!group.features.has(permission.feature_key)) {
      group.features.set(permission.feature_key, {
        key: permission.feature_key,
        label: permission.feature_label,
        permissions: [],
      })
    }

    group.features.get(permission.feature_key).permissions.push(permission)
  }

  return [...groups.values()].map((group) => ({
    key: group.key,
    label: group.label,
    features: [...group.features.values()],
  }))
}

async function loadAllPermissions() {
  const { data, error } = await supabase
    .from('admin_permissions')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('permission_key', { ascending: true })

  if (error) throw error

  return data || []
}

async function resolvePermissionIds(permissionKeys) {
  const keys = cleanPermissionKeys(permissionKeys)

  if (keys.length === 0) {
    return {
      keys: [],
      ids: [],
    }
  }

  const blocked = keys.filter((key) => OWNER_ONLY_PERMISSION_KEYS.has(key))

  if (blocked.length > 0) {
    const error = new Error(`Owner-only permissions cannot be assigned: ${blocked.join(', ')}`)
    error.status = 400
    throw error
  }

  const { data, error } = await supabase
    .from('admin_permissions')
    .select('id, permission_key')
    .in('permission_key', keys)

  if (error) throw error

  const found = data || []
  const foundKeys = new Set(found.map((item) => item.permission_key))
  const missing = keys.filter((key) => !foundKeys.has(key))

  if (missing.length > 0) {
    const validationError = new Error(`Unknown permissions: ${missing.join(', ')}`)
    validationError.status = 400
    throw validationError
  }

  return {
    keys,
    ids: found.map((item) => item.id),
  }
}

async function loadRole(roleId) {
  const { data, error } = await supabase
    .from('admin_roles')
    .select('*')
    .eq('id', roleId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function loadRolesWithPermissions() {
  const [{ data: roles, error: rolesError }, permissions] = await Promise.all([
    supabase
      .from('admin_roles')
      .select('*')
      .order('is_system', { ascending: false })
      .order('name', { ascending: true }),
    loadAllPermissions(),
  ])

  if (rolesError) throw rolesError

  const roleRows = roles || []

  if (roleRows.length === 0) return []

  const roleIds = roleRows.map((role) => role.id)

  const { data: links, error: linksError } = await supabase
    .from('admin_role_permissions')
    .select('role_id, permission_id')
    .in('role_id', roleIds)

  if (linksError) throw linksError

  const permissionById = new Map(
    permissions.map((permission) => [permission.id, permission])
  )

  const permissionsByRole = new Map()

  for (const link of links || []) {
    const permission = permissionById.get(link.permission_id)
    if (!permission) continue

    if (!permissionsByRole.has(link.role_id)) {
      permissionsByRole.set(link.role_id, [])
    }

    permissionsByRole.get(link.role_id).push(permission)
  }

  return roleRows.map((role) => {
    const rolePermissions = permissionsByRole.get(role.id) || []

    return {
      ...role,
      permission_keys: rolePermissions.map((permission) => permission.permission_key),
      permissions: rolePermissions,
      staff_count: 0,
    }
  })
}

async function replaceRolePermissions(roleId, permissionIds) {
  const { data: oldLinks, error: oldLinksError } = await supabase
    .from('admin_role_permissions')
    .select('role_id, permission_id')
    .eq('role_id', roleId)

  if (oldLinksError) throw oldLinksError

  const { error: deleteError } = await supabase
    .from('admin_role_permissions')
    .delete()
    .eq('role_id', roleId)

  if (deleteError) throw deleteError

  if (permissionIds.length === 0) return

  const { error: insertError } = await supabase
    .from('admin_role_permissions')
    .insert(
      permissionIds.map((permissionId) => ({
        role_id: roleId,
        permission_id: permissionId,
      }))
    )

  if (!insertError) return

  if ((oldLinks || []).length > 0) {
    await supabase
      .from('admin_role_permissions')
      .upsert(oldLinks, {
        onConflict: 'role_id,permission_id',
        ignoreDuplicates: true,
      })
  }

  throw insertError
}

router.get('/permissions', viewRoles, async (req, res) => {
  try {
    const permissions = await loadAllPermissions()

    return res.status(200).json({
      ok: true,
      permissions,
      groups: groupPermissions(permissions),
      owner_only_permission_keys: [...OWNER_ONLY_PERMISSION_KEYS],
    })
  } catch (error) {
    console.error('GET ADMIN ROLE PERMISSIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load role permissions',
    })
  }
})

router.get('/', viewRoles, async (req, res) => {
  try {
    const roles = await loadRolesWithPermissions()

    return res.status(200).json({
      ok: true,
      roles,
    })
  } catch (error) {
    console.error('GET ADMIN ROLES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load roles',
    })
  }
})

router.post('/', manageRoles, requireOwner, async (req, res) => {
  let createdRole = null

  try {
    const name = cleanText(req.body?.name, 60)
    const description = cleanText(req.body?.description, 300)
    const permissionKeys = cleanPermissionKeys(req.body?.permission_keys)

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Role name must be at least 2 characters',
      })
    }

    if (isReservedRoleName(name)) {
      return res.status(400).json({
        ok: false,
        message: 'Owner is a protected system role',
      })
    }

    const resolved = await resolvePermissionIds(permissionKeys)

    const { data, error } = await supabase
      .from('admin_roles')
      .insert({
        name,
        description,
        is_system: false,
        is_protected: false,
        created_by_admin_id: req.admin?.admin_id || null,
        created_by_name: getAdminActor(req),
      })
      .select()
      .single()

    if (error) throw error

    createdRole = data

    if (resolved.ids.length > 0) {
      const { error: linkError } = await supabase
        .from('admin_role_permissions')
        .insert(
          resolved.ids.map((permissionId) => ({
            role_id: data.id,
            permission_id: permissionId,
          }))
        )

      if (linkError) throw linkError
    }

    await logAdminActivity({
      action: 'ROLE_CREATE',
      section_key: 'roles',
      item_id: data.id,
      title: data.name,
      actor: getAdminActor(req),
      details: `Created role ${data.name} with ${resolved.keys.length} permissions.`,
    })

    const roles = await loadRolesWithPermissions()
    const role = roles.find((item) => item.id === data.id) || data

    return res.status(201).json({
      ok: true,
      role,
    })
  } catch (error) {
    if (createdRole?.id) {
      await supabase
        .from('admin_roles')
        .delete()
        .eq('id', createdRole.id)
    }

    console.error('CREATE ADMIN ROLE ERROR:', error)

    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        message: 'A role with this name already exists',
      })
    }

    return res.status(error.status || 500).json({
      ok: false,
      message: error.message || 'Failed to create role',
    })
  }
})

router.patch('/:roleId', manageRoles, requireOwner, async (req, res) => {
  try {
    const role = await loadRole(req.params.roleId)

    if (!role) {
      return res.status(404).json({
        ok: false,
        message: 'Role not found',
      })
    }

    if (role.is_system || role.is_protected) {
      return res.status(403).json({
        ok: false,
        message: 'Protected system roles cannot be edited',
      })
    }

    const updates = {}

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const name = cleanText(req.body?.name, 60)

      if (name.length < 2) {
        return res.status(400).json({
          ok: false,
          message: 'Role name must be at least 2 characters',
        })
      }

      if (isReservedRoleName(name)) {
        return res.status(400).json({
          ok: false,
          message: 'Owner is a protected system role',
        })
      }

      updates.name = name
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) {
      updates.description = cleanText(req.body?.description, 300)
    }

    let resolved = null

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'permission_keys')) {
      resolved = await resolvePermissionIds(req.body?.permission_keys)
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from('admin_roles')
        .update(updates)
        .eq('id', role.id)

      if (updateError) throw updateError
    }

    if (resolved) {
      await replaceRolePermissions(role.id, resolved.ids)
    }

    const roles = await loadRolesWithPermissions()
    const updatedRole = roles.find((item) => item.id === role.id)

    await logAdminActivity({
      action: 'ROLE_UPDATE',
      section_key: 'roles',
      item_id: role.id,
      title: updatedRole?.name || role.name,
      actor: getAdminActor(req),
      details: `Updated role ${updatedRole?.name || role.name}.`,
    })

    return res.status(200).json({
      ok: true,
      role: updatedRole,
    })
  } catch (error) {
    console.error('UPDATE ADMIN ROLE ERROR:', error)

    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        message: 'A role with this name already exists',
      })
    }

    return res.status(error.status || 500).json({
      ok: false,
      message: error.message || 'Failed to update role',
    })
  }
})

router.delete('/:roleId', manageRoles, requireOwner, async (req, res) => {
  try {
    const role = await loadRole(req.params.roleId)

    if (!role) {
      return res.status(404).json({
        ok: false,
        message: 'Role not found',
      })
    }

    if (role.is_system || role.is_protected) {
      return res.status(403).json({
        ok: false,
        message: 'Protected system roles cannot be deleted',
      })
    }

    const { error } = await supabase
      .from('admin_roles')
      .delete()
      .eq('id', role.id)

    if (error) throw error

    await logAdminActivity({
      action: 'ROLE_DELETE',
      section_key: 'roles',
      item_id: role.id,
      title: role.name,
      actor: getAdminActor(req),
      details: `Deleted role ${role.name}.`,
    })

    return res.status(200).json({
      ok: true,
      deleted_role_id: role.id,
    })
  } catch (error) {
    console.error('DELETE ADMIN ROLE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete role',
    })
  }
})

export default router
