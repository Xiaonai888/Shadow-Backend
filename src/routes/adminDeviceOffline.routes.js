import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PAGE = 10000
const toPage = (value) => Math.min(MAX_PAGE, Math.max(1, Number.parseInt(value, 10) || 1))
const clean = (value, length = 80) => String(value || '').trim().slice(0, length)
const adminActor = (req) => ({
  id: clean(req.admin?.admin_id || req.admin?.id, 120),
  name: clean(req.admin?.name || req.admin?.actor || req.admin?.email, 120),
})

router.use(requireAdminPermission('system_control.manage'))
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

const searchLimiter = createRateLimit({ key: 'admin-offline-search', windowMs: 60000, max: 30, identity: (req) => req.admin?.admin_id })
const mutationLimiter = createRateLimit({ key: 'admin-offline-mutation', windowMs: 60000, max: 10, identity: (req) => req.admin?.admin_id })

async function confirmPin(req, purpose) {
  if (!/^\d{6}$/.test(String(req.body?.pin || ''))) return { ok: false, status: 400, message: '6-digit Admin Passkey is required' }
  return verifyAdminPasskeyPin({ admin: req.admin, req, pin: req.body.pin, purpose })
}

function sendError(res, error, label) {
  console.error(label, error)
  return res.status(500).json({ ok: false, message: 'Unable to complete offline control request' })
}

router.get('/global', async (req, res) => {
  try {
    const { data, error } = await supabase.from('reader_offline_global_control')
      .select('paused,pause_until,updated_at,updated_by').eq('id', 1).single()
    if (error) throw error
    const paused = Boolean(data.paused) && (!data.pause_until || new Date(data.pause_until).getTime() > Date.now())
    return res.json({ ok: true, global: { ...data, paused } })
  } catch (error) { return sendError(res, error, 'OFFLINE GLOBAL READ') }
})

router.patch('/global', mutationLimiter, async (req, res) => {
  const paused = req.body?.paused
  const duration = req.body?.duration_minutes
  if (typeof paused !== 'boolean' || (paused && duration !== null && ![60, 360].includes(duration))) {
    return res.status(400).json({ ok: false, message: 'Invalid pause duration' })
  }
  try {
    const verified = await confirmPin(req, 'reader_offline_global_control')
    if (!verified.ok) return res.status(verified.status || 403).json({ ok: false, message: verified.message })
    const actor = adminActor(req)
    const { data, error } = await supabase.rpc('shadow_offline_admin_set_global', {
      p_paused: paused,
      p_duration_minutes: paused ? duration : null,
      p_admin_id: actor.id,
      p_admin_name: actor.name,
      p_note: clean(req.body.note, 300),
    })
    if (error) throw error
    return res.json({ ok: true, global: data })
  } catch (error) { return sendError(res, error, 'OFFLINE GLOBAL MUTATION') }
})

router.get('/readers', searchLimiter, async (req, res) => {
  const q = clean(req.query.q)
  if (q.length < 2) return res.status(400).json({ ok: false, message: 'Enter at least two characters' })
  const page = toPage(req.query.page)
  try {
    const { data, error } = await supabase.rpc('shadow_offline_admin_search_readers', { p_query: q, p_page: page })
    if (error) throw error
    return res.json({ ok: true, items: data?.items || [], total: Number(data?.total || 0), page, limit: 10 })
  } catch (error) { return sendError(res, error, 'OFFLINE READER SEARCH') }
})

router.get('/readers/:userId/devices', searchLimiter, async (req, res) => {
  const userId = String(req.params.userId || '')
  if (!UUID.test(userId)) return res.status(400).json({ ok: false, message: 'Invalid reader ID' })
  try {
    const { data: devices, error } = await supabase.from('reader_devices')
      .select('id,device_label,os_name,browser_name,last_seen_at')
      .eq('user_id', userId).order('last_seen_at', { ascending: false }).limit(10)
    if (error) throw error
    const ids = (devices || []).map((device) => device.id)
    let overrides = []
    if (ids.length) {
      const result = await supabase.from('reader_offline_device_overrides')
        .select('device_id,mode').eq('user_id', userId).in('device_id', ids).limit(10)
      if (result.error) throw result.error
      overrides = result.data || []
    }
    const modes = new Map(overrides.map((value) => [value.device_id, value.mode]))
    return res.json({ ok: true, items: (devices || []).map((d) => ({ ...d, mode: modes.get(d.id) || 'inherit' })) })
  } catch (error) { return sendError(res, error, 'OFFLINE READER DEVICES') }
})

router.patch('/devices/:deviceId', mutationLimiter, async (req, res) => {
  const deviceId = String(req.params.deviceId || '')
  const userId = String(req.body?.user_id || '')
  const mode = String(req.body?.mode || '')
  if (!UUID.test(deviceId) || !UUID.test(userId) || !['force_online', 'auto_offline', 'inherit'].includes(mode)) {
    return res.status(400).json({ ok: false, message: 'Invalid device selection or mode' })
  }
  try {
    const verified = await confirmPin(req, 'reader_offline_device_override')
    if (!verified.ok) return res.status(verified.status || 403).json({ ok: false, message: verified.message })
    const actor = adminActor(req)
    const { data, error } = await supabase.rpc('shadow_offline_admin_set_device', {
      p_user_id: userId,
      p_device_id: deviceId,
      p_mode: mode,
      p_admin_id: actor.id,
      p_admin_name: actor.name,
      p_note: clean(req.body.note, 300),
    })
    if (error) {
      if (error.message?.includes('Reader device not found')) return res.status(404).json({ ok: false, message: 'Reader device not found' })
      throw error
    }
    return res.json({ ok: true, device: data })
  } catch (error) { return sendError(res, error, 'OFFLINE DEVICE MUTATION') }
})

router.get('/report', searchLimiter, async (req, res) => {
  const scope = clean(req.query.scope, 20) || 'all'
  const status = clean(req.query.status, 30) || 'all'
  const q = clean(req.query.q)
  const page = toPage(req.query.page)
  if (!['all', 'global', 'individual'].includes(scope) ||
      !['all', 'force_online', 'auto_offline', 'inherit', 'paused', 'normal'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'Invalid report filter' })
  }
  try {
    const { data, error } = await supabase.rpc('shadow_offline_admin_report', {
      p_query: q, p_scope: scope, p_status: status, p_page: page,
    })
    if (error) throw error
    return res.json({ ok: true, items: data?.items || [], total: Number(data?.total || 0), page, limit: 10 })
  } catch (error) { return sendError(res, error, 'OFFLINE REPORT') }
})

export default router
