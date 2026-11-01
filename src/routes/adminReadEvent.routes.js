import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  prepareShadowReadEvent,
} from '../services/shadowReadEventPreparation.service.js'
import {
  getNextShadowReadEventStart,
  validateShadowReadEventStart,
  SHADOW_READ_EVENT_PRIZES,
} from '../services/shadowReadEventPlanner.service.js'

const router = express.Router()

const ipLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_READ_EVENT_IP_RATE_LIMIT' },
})

function adminIdentity(req) {
  return String(req.admin?.admin_id || req.admin?.email || ipKeyGenerator(req.ip))
}

const readLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: adminIdentity,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_READ_EVENT_RATE_LIMIT' },
})

const writeLimit = rateLimit({
  windowMs: 60_000,
  limit: 3,
  keyGenerator: adminIdentity,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_READ_EVENT_PREPARE_RATE_LIMIT' },
})

function eventDate(value) {
  if (value === undefined || value === null || value === '') {
    return getNextShadowReadEventStart()
  }
  if (typeof value !== 'string' || value.length !== 10) return null
  try {
    return validateShadowReadEventStart(value)
  } catch {
    return null
  }
}

function ensureEventManager(req, res, next) {
  if (req.admin?.role !== 'owner' && req.admin?.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      code: 'ADMIN_READ_EVENT_MANAGER_REQUIRED',
    })
  }
  return next()
}

router.use(ipLimit, requireAdminPermission('monthly_vote.view'))

router.get('/', readLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const startsOn = eventDate(req.query?.starts_on)
  if (!startsOn) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_START_INVALID' })
  }

  try {
    const { data: week, error } = await supabase
      .from('shadow_read_event_weeks')
      .select('id,starts_on,featured_story_id,audience_group,is_enabled,created_at,updated_at')
      .eq('starts_on', startsOn)
      .maybeSingle()
    if (error) throw error
    if (!week) {
      return res.json({
        ok: true,
        exists: false,
        starts_on: startsOn,
        event: null,
        missions: [],
        milestones: [],
        participant_count: 0,
        prize_rules: SHADOW_READ_EVENT_PRIZES,
      })
    }

    const [missions, milestones, participants] = await Promise.all([
      supabase.from('shadow_read_event_missions')
        .select('id,day_number,slot,mission_type,story_id,mission_params,target_amount,max_points')
        .eq('event_id', week.id)
        .order('day_number', { ascending: true })
        .order('slot', { ascending: true })
        .limit(35),
      supabase.from('shadow_read_event_milestones')
        .select('day_number,tier,required_points,coin_reward')
        .eq('event_id', week.id)
        .order('day_number', { ascending: true })
        .order('tier', { ascending: true })
        .limit(35),
      supabase.from('shadow_read_event_participants')
        .select('user_id', { count: 'exact', head: true })
        .eq('event_id', week.id),
    ])

    for (const result of [missions, milestones, participants]) {
      if (result.error) throw result.error
    }

    return res.json({
      ok: true,
      exists: true,
      starts_on: startsOn,
      event: week,
      missions: missions.data || [],
      milestones: milestones.data || [],
      participant_count: Number(participants.count || 0),
      plan_complete: (missions.data || []).length === 35 &&
        (milestones.data || []).length === 35,
      prize_rules: SHADOW_READ_EVENT_PRIZES,
    })
  } catch (error) {
    console.error('ADMIN_READ_EVENT_OVERVIEW_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(503).json({
      ok: false,
      code: 'ADMIN_READ_EVENT_UNAVAILABLE',
    })
  }
})

router.post('/prepare', ensureEventManager, writeLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const startsOn = eventDate(req.body?.starts_on)
  if (!startsOn) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_START_INVALID' })
  }

  try {
    const result = await prepareShadowReadEvent(startsOn)
    return res.json({
      ...result,
      enabled_by_action: false,
    })
  } catch (error) {
    console.error('ADMIN_READ_EVENT_PREPARE_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(503).json({
      ok: false,
      code: 'ADMIN_READ_EVENT_PREPARE_UNAVAILABLE',
    })
  }
})


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.patch('/status', ensureEventManager, writeLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const eventId = req.body?.event_id
  const enabled = req.body?.enabled
  const adminId = req.admin?.admin_id

  if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId) ||
      typeof enabled !== 'boolean' ||
      typeof adminId !== 'string' || !UUID_PATTERN.test(adminId)) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_STATUS_INVALID' })
  }

  try {
    const { data, error } = await supabase.rpc('shadow_read_event_set_enabled', {
      p_event_id: eventId,
      p_enabled: enabled,
      p_admin_id: adminId,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.ok !== true ||
        typeof result.changed !== 'boolean' ||
        String(result.event_id) !== eventId ||
        result.is_enabled !== enabled) {
      throw new Error('Invalid Read Event status response')
    }
    return res.json(result)
  } catch (error) {
    console.error('ADMIN_READ_EVENT_STATUS_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(error?.code === '22023' ? 409 : 503).json({
      ok: false,
      code: error?.code === '22023'
        ? 'READ_EVENT_STATUS_NOT_ALLOWED'
        : 'READ_EVENT_STATUS_UNAVAILABLE',
    })
  }
})

export default router
