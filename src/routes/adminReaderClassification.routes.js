import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getAdminActor } from '../services/adminActivity.service.js'

const router = express.Router()
const LIMIT = 10
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COUNTRIES_INVALID = new Set(['XX', 'ZZ', 'T1'])
const GROUPS = new Set(['all', 'kh', 'international', 'unknown'])

router.use(requireAdminPermission('system_control.manage'))
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

const readLimit = createRateLimit({
  key: 'admin-reader-classification-read',
  windowMs: 60000,
  max: 60,
  identity: req => req.admin?.admin_id || req.ip,
})
const writeLimit = createRateLimit({
  key: 'admin-reader-classification-write',
  windowMs: 60000,
  max: 12,
  identity: req => req.admin?.admin_id || req.ip,
})

function validCountry(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && !COUNTRIES_INVALID.has(value)
}

function cleanSearch(value) {
  return String(value || '').trim().replace(/[%,()\\\u0000-\u001f\u007f]/g, '').slice(0, 90)
}

function fail(res, error, label) {
  console.error(`READER CLASSIFICATION ${label}:`, error)
  return res.status(503).json({ ok: false, message: 'Reader Classification data is temporarily unavailable' })
}

router.get('/', readLimit, async (req, res) => {
  const group = String(req.query.group || 'all').trim().toLowerCase()
  const requestedLimit = req.query.limit === undefined ? LIMIT : Number(req.query.limit)
  const page = req.query.page === undefined ? 1 : Number(req.query.page)
  if (!GROUPS.has(group) || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > LIMIT || page !== 1) {
    return res.status(400).json({ ok: false, message: 'Invalid list parameters' })
  }

  const search = cleanSearch(req.query.q)
  if (req.query.q !== undefined && search.length < 2) {
    return res.status(400).json({ ok: false, message: 'Search requires at least two characters' })
  }

  try {
    const { data, error } = await supabase.rpc('get_admin_reader_classification_analytics', {
      p_search: search,
      p_group: group,
      p_limit: requestedLimit,
    })
    if (error) throw error
    if (!data || data.ok !== true || !Array.isArray(data.items) || !data.summary || typeof data.summary !== 'object') {
      throw new Error('Invalid reader classification analytics result')
    }
    if (data.items.length > requestedLimit || data.page !== 1 || data.limit !== requestedLimit || typeof data.has_next !== 'boolean') {
      throw new Error('Unexpected reader classification pagination result')
    }
    return res.json(data)
  } catch (error) {
    return fail(res, error, 'LIST')
  }
})

router.patch('/:readerId', writeLimit, async (req, res) => {
  const userId = String(req.params.readerId || '').trim()
  if (!UUID.test(userId)) return res.status(400).json({ ok: false, message: 'Invalid reader ID' })
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, message: 'Invalid request body' })
  }
  if (Object.keys(body).some(key => !['admin_country_override', 'admin_group_override'].includes(key))) {
    return res.status(400).json({ ok: false, message: 'Unsupported fields' })
  }
  if (!('admin_country_override' in body) && !('admin_group_override' in body)) {
    return res.status(400).json({ ok: false, message: 'No changes requested' })
  }

  const hasCountry = Object.prototype.hasOwnProperty.call(body, 'admin_country_override')
  const hasGroup = Object.prototype.hasOwnProperty.call(body, 'admin_group_override')
  const countryRaw = body.admin_country_override
  const groupRaw = body.admin_group_override
  const country = hasCountry
    ? countryRaw === null || countryRaw === '' ? null : String(countryRaw).trim().toUpperCase()
    : undefined
  const group = hasGroup
    ? groupRaw === null || groupRaw === '' ? null : groupRaw
    : undefined
  if (hasCountry && country !== null && !validCountry(country)) return res.status(400).json({ ok: false, message: 'Invalid country code' })
  if (hasGroup && group !== null && !['kh', 'international'].includes(group)) return res.status(400).json({ ok: false, message: 'Invalid reader group' })

  try {
    const { data: user, error: userError } = await supabase
      .from('users').select('id').eq('id', userId).maybeSingle()
    if (userError) throw userError
    if (!user) return res.status(404).json({ ok: false, message: 'Reader not found' })

    const { data: current, error: currentError } = await supabase
      .from('shadow_reader_classifications')
      .select('user_id,detected_country,admin_country_override,admin_group_override')
      .eq('user_id', userId).maybeSingle()
    if (currentError) throw currentError

    const nextCountry = 'admin_country_override' in body ? country : current?.admin_country_override || null
    const nextGroup = 'admin_group_override' in body ? group : current?.admin_group_override || null
    const oldCountry = current?.admin_country_override || null
    const oldGroup = current?.admin_group_override || null
    if (nextCountry === oldCountry && nextGroup === oldGroup) {
      return res.json({ ok: true, changed: false })
    }

    const { error: saveError } = await supabase
      .from('shadow_reader_classifications')
      .upsert({
        user_id: userId,
        admin_country_override: nextCountry,
        admin_group_override: nextGroup,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    if (saveError) throw saveError

    const { error: historyError } = await supabase
      .from('shadow_reader_classification_history')
      .insert({
        user_id: userId,
        previous_country: oldCountry || current?.detected_country || null,
        new_country: nextCountry || current?.detected_country || null,
        previous_group: oldGroup,
        new_group: nextGroup,
        changed_by: String(getAdminActor(req) || 'Admin').slice(0, 150),
      })
    if (historyError) {
      console.error('READER CLASSIFICATION HISTORY FAILED AFTER SAVE:', historyError)
      return res.status(503).json({
        ok: false,
        code: 'COUNTRY_SAVED_HISTORY_FAILED',
        message: 'Changes were saved but the history entry failed. Do not retry blindly; check the reader first.',
      })
    }

    return res.json({
      ok: true,
      changed: true,
      effective_country: nextCountry || current?.detected_country || null,
      admin_country_override: nextCountry,
      admin_group_override: nextGroup,
    })
  } catch (error) {
    return fail(res, error, 'SAVE')
  }
})

export default router
