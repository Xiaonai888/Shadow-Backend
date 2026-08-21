import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getAdminActor, logAdminActivity } from '../services/adminActivity.service.js'

const router = express.Router()
const viewAccounts = requireAdminPermission('accounts.view')
const manageAccounts = requireAdminPermission('accounts.manage')

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanEmail(value) {
  return cleanText(value, 200).toLowerCase()
}

function validStatus(value) {
  return ['active', 'inactive', 'suspended'].includes(String(value || '').trim().toLowerCase())
}

function publicAccount(account, role = null) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    legacy_role: account.role,
    role_id: account.role_id || null,
    role: role
      ? {
          id: role.id,
          name: role.name,
          description: role.description || '',
          is_system: Boolean(role.is_system),
          is_protected: Boolean(role.is_protected),
          system_key: role.system_key || null,
        }
      : null,
    role_name: role?.name || (
      String(account.role || '').toLowerCase() === 'owner'
        ? 'Owner'
        : String(account.role || '').toLowerCase() === 'admin'
          ? 'Admin'
          : 'Unassigned'
    ),
    status: account.status || 'active',
    last_login_at: account.last_login_at || null,
    created_at: account.created_at || null,
    updated_at: account.updated_at || null,
  }
}

async function loadRole(roleId) {
  if (!roleId) return null

  const { data, error } = await supabase
    .from('admin_roles')
    .select('id, system_key, name, description, is_system, is_protected')
    .eq('id', roleId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function loadAvailableRoles() {
  const { data, error } = await supabase
    .from('admin_roles')
    .select('id, system_key, name, description, is_system, is_protected')
    .order('is_system', { ascending: false })
    .order('name', { ascending: true })

  if (error) throw error

  return data || []
}

async function loadAccount(accountId) {
  const { data, error } = await supabase
    .from('admin_users')
    .select('id, email, name, role, role_id, status, last_login_at, created_at, updated_at')
    .eq('id', accountId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function loadAccounts() {
  const { data: accounts, error } = await supabase
    .from('admin_users')
    .select('id, email, name, role, role_id, status, last_login_at, created_at, updated_at')
    .order('created_at', { ascending: true })

  if (error) throw error

  const rows = accounts || []
  const roleIds = [...new Set(rows.map((item) => item.role_id).filter(Boolean))]

  let roles = []

  if (roleIds.length > 0) {
    const { data, error: rolesError } = await supabase
      .from('admin_roles')
      .select('id, system_key, name, description, is_system, is_protected')
      .in('id', roleIds)

    if (rolesError) throw rolesError
    roles = data || []
  }

  const roleMap = new Map(roles.map((role) => [role.id, role]))

  return rows.map((account) =>
    publicAccount(account, account.role_id ? roleMap.get(account.role_id) : null)
  )
}

function canManageTarget(req, account) {
  const requesterRole = String(req.admin?.role || '').trim().toLowerCase()
  const targetRole = String(account?.role || '').trim().toLowerCase()

  if (targetRole === 'owner') {
    return {
      ok: false,
      status: 403,
      message: 'Owner account cannot be modified here',
    }
  }

  if (targetRole === 'admin' && requesterRole !== 'owner') {
    return {
      ok: false,
      status: 403,
      message: 'Only Owner can modify an Admin account',
    }
  }

  return { ok: true }
}

router.get('/roles', viewAccounts, async (req, res) => {
  try {
    const roles = await loadAvailableRoles()

    return res.status(200).json({
      ok: true,
      roles,
    })
  } catch (error) {
    console.error('GET ACCOUNT ROLES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load saved roles',
    })
  }
})

router.get('/', viewAccounts, async (req, res) => {
  try {
    const accounts = await loadAccounts()

    return res.status(200).json({
      ok: true,
      accounts,
      total: accounts.length,
    })
  } catch (error) {
    console.error('GET ADMIN ACCOUNTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load staff accounts',
    })
  }
})

router.post('/', manageAccounts, async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 120)
    const email = cleanEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const roleId = cleanText(req.body?.role_id, 80)
    const status = String(req.body?.status || 'active').trim().toLowerCase()

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Full name must be at least 2 characters',
      })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid email address is required',
      })
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: 'Password must be at least 8 characters',
      })
    }

    if (!roleId) {
      return res.status(400).json({
        ok: false,
        message: 'Role is required',
      })
    }

    if (!validStatus(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid account status',
      })
    }

    const role = await loadRole(roleId)

    if (!role) {
      return res.status(404).json({
        ok: false,
        message: 'Selected role was not found',
      })
    }

    if (role.is_system || role.is_protected || role.system_key === 'owner') {
      return res.status(403).json({
        ok: false,
        message: 'System/Owner role cannot be assigned to a new staff account',
      })
    }

    const { data, error } = await supabase.rpc('create_admin_staff_account', {
      p_name: name,
      p_email: email,
      p_password: password,
      p_role_id: role.id,
      p_status: status,
    })

    if (error) throw error

    const created = Array.isArray(data) ? data[0] : data

    if (!created?.id) {
      throw new Error('Staff account was not created')
    }

    await logAdminActivity({
      action: 'ACCOUNT_CREATE',
      section_key: 'accounts',
      item_id: created.id,
      title: name,
      actor: getAdminActor(req),
      details: `Created staff account ${email} with role ${role.name}.`,
    })

    const account = await loadAccount(created.id)

    return res.status(201).json({
      ok: true,
      account: publicAccount(account, role),
    })
  } catch (error) {
    console.error('CREATE ADMIN ACCOUNT ERROR:', error)

    const message = String(error?.message || '')

    if (
      message.includes('already exists') ||
      message.includes('must be') ||
      message.includes('required') ||
      message.includes('not found') ||
      message.includes('cannot be assigned') ||
      error?.code === '23505'
    ) {
      return res.status(400).json({
        ok: false,
        message: message || 'Failed to create staff account',
      })
    }

    return res.status(500).json({
      ok: false,
      message: 'Failed to create staff account',
    })
  }
})

router.patch('/:accountId', manageAccounts, async (req, res) => {
  try {
    const account = await loadAccount(req.params.accountId)

    if (!account) {
      return res.status(404).json({
        ok: false,
        message: 'Staff account not found',
      })
    }

    const allowed = canManageTarget(req, account)

    if (!allowed.ok) {
      return res.status(allowed.status).json({
        ok: false,
        message: allowed.message,
      })
    }

    const updates = {}
    let selectedRole = null

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const name = cleanText(req.body?.name, 120)

      if (name.length < 2) {
        return res.status(400).json({
          ok: false,
          message: 'Full name must be at least 2 characters',
        })
      }

      updates.name = name
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
      const status = String(req.body?.status || '').trim().toLowerCase()

      if (!validStatus(status)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid account status',
        })
      }

      updates.status = status
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role_id')) {
      if (String(account.role || '').toLowerCase() !== 'staff') {
        return res.status(403).json({
          ok: false,
          message: 'Legacy Owner/Admin role cannot be replaced from Staff Accounts',
        })
      }

      const roleId = cleanText(req.body?.role_id, 80)
      selectedRole = await loadRole(roleId)

      if (!selectedRole) {
        return res.status(404).json({
          ok: false,
          message: 'Selected role was not found',
        })
      }

      if (
        selectedRole.is_system ||
        selectedRole.is_protected ||
        selectedRole.system_key === 'owner'
      ) {
        return res.status(403).json({
          ok: false,
          message: 'System/Owner role cannot be assigned to staff',
        })
      }

      updates.role_id = selectedRole.id
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'No account changes provided',
      })
    }

    const { error } = await supabase
      .from('admin_users')
      .update(updates)
      .eq('id', account.id)

    if (error) throw error

    const updated = await loadAccount(account.id)

    if (!selectedRole && updated?.role_id) {
      selectedRole = await loadRole(updated.role_id)
    }

    await logAdminActivity({
      action: 'ACCOUNT_UPDATE',
      section_key: 'accounts',
      item_id: account.id,
      title: updated?.name || account.name,
      actor: getAdminActor(req),
      details: `Updated staff account ${updated?.email || account.email}.`,
    })

    return res.status(200).json({
      ok: true,
      account: publicAccount(updated, selectedRole),
    })
  } catch (error) {
    console.error('UPDATE ADMIN ACCOUNT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update staff account',
    })
  }
})

export default router
