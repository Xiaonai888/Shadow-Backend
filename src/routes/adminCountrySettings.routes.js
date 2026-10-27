import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getAdminActor, logAdminActivity } from '../services/adminActivity.service.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REGIONS = ['kh', 'international']
const LEGACY_BOOLEAN_KEYS = ['app', 'physicalBooks', 'binancePay', 'payway']
const PAYOUT_BOOLEAN_KEYS = ['payoutBank', 'payoutBinance', 'payoutPhone']
const BOOLEAN_KEYS = [...LEGACY_BOOLEAN_KEYS, 'shadowMall', 'readerMall', ...PAYOUT_BOOLEAN_KEYS]
const RULE_KEYS = [...BOOLEAN_KEYS, 'storyLanguage', 'shopTarget']
const LANGUAGES = ['km', 'en', 'zh', 'ja', 'ko']
const SHOP_TARGETS = ['shadow_mall', 'diamonds']
const EXCEPTION_MODES = ['cambodia_experience', 'all_eligible', 'custom']
// Country Rules are the source of truth for every boolean exception flag,
// including flags introduced after this page was first deployed.
const EXTRA_BOOLEAN_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/
const MAX_RULE_KEYS = 64
const LIMIT = 10

router.use(requireAdminPermission('system_control.manage'))
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

const readLimit = createRateLimit({ key: 'country-settings-read', windowMs: 60000, max: 60, identity: req => req.admin?.admin_id })
const writeLimit = createRateLimit({ key: 'country-settings-write', windowMs: 60000, max: 12, identity: req => req.admin?.admin_id })

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRules(value) {
  if (!isRecord(value) || Object.keys(value).length !== REGIONS.length ||
      REGIONS.some(region => !isRecord(value[region]))) return null

  const result = {}
  for (const region of REGIONS) {
    const entry = value[region]
    const keys = Object.keys(entry)
    if (keys.length > MAX_RULE_KEYS) return null
    if (!LEGACY_BOOLEAN_KEYS.every(key => typeof entry[key] === 'boolean')) return null
    if (!LANGUAGES.includes(entry.storyLanguage) || !SHOP_TARGETS.includes(entry.shopTarget)) return null
    if (keys.some(key => !RULE_KEYS.includes(key) &&
        (!EXTRA_BOOLEAN_KEY.test(key) || typeof entry[key] !== 'boolean'))) return null
    if (['shadowMall', 'readerMall', ...PAYOUT_BOOLEAN_KEYS].some(key =>
        entry[key] !== undefined && typeof entry[key] !== 'boolean')) return null

    const next = {
      ...entry,
      shadowMall: typeof entry.shadowMall === 'boolean' ? entry.shadowMall : region === 'kh',
      readerMall: typeof entry.readerMall === 'boolean' ? entry.readerMall : region === 'kh',
      payoutBank: typeof entry.payoutBank === 'boolean' ? entry.payoutBank : region === 'kh',
      payoutBinance: typeof entry.payoutBinance === 'boolean' ? entry.payoutBinance : false,
      payoutPhone: typeof entry.payoutPhone === 'boolean' ? entry.payoutPhone : true,
    }
    result[region] = Object.fromEntries(Object.entries(next))
  }

  // Do not accept a switch that exists in only one region.
  const khKeys = Object.keys(result.kh).sort()
  const otherKeys = Object.keys(result.international).sort()
  if (JSON.stringify(khKeys) !== JSON.stringify(otherKeys)) return null
  for (const key of khKeys) {
    if (key !== 'storyLanguage' && key !== 'shopTarget' &&
        (typeof result.kh[key] !== 'boolean' || typeof result.international[key] !== 'boolean')) return null
  }
  return result
}

function normalizeOverrides(value, rules) {
  if (!isRecord(value) || !rules || Object.keys(value).length > MAX_RULE_KEYS) return null
  const result = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!EXTRA_BOOLEAN_KEY.test(key)) return null
    if (!Object.hasOwn(rules.kh, key) || !Object.hasOwn(rules.international, key)) return null
    if (candidate === undefined || candidate === 'inherit') continue
    if (key === 'storyLanguage') {
      if (!LANGUAGES.includes(candidate)) return null
    } else if (key === 'shopTarget') {
      if (!SHOP_TARGETS.includes(candidate)) return null
    } else {
      if (typeof rules.kh[key] !== 'boolean' || typeof rules.international[key] !== 'boolean' ||
          !['allow', 'block'].includes(candidate)) return null
    }
    result[key] = candidate
  }
  return result
}

function fail(res, error, area) {
  console.error(`COUNTRY SETTINGS ${area}:`, error)
  return res.status(500).json({ ok: false, message: 'Country Settings request failed' })
}

function cleanSearch(value) {
  return String(value || '').trim().replace(/[%,()_\\]/g, ' ').slice(0, 90)
}

async function audit(req, action, itemId, title, details) {
  await logAdminActivity({
    action,
    section_key: 'country_settings',
    item_id: itemId,
    title,
    actor: getAdminActor(req),
    details,
  })
}

router.get('/', readLimit, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shadow_country_settings')
      .select('rules,revision,updated_at')
      .eq('settings_key', 'default')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(503).json({ ok: false, message: 'Run country_settings_setup.sql before using this page' })
    const rules = normalizeRules(data.rules)
    if (!rules) return res.status(500).json({ ok: false, message: 'Saved Country Rules are invalid' })
    return res.json({ ok: true, rules, revision: data.revision, updatedAt: data.updated_at })
  } catch (error) {
    return fail(res, error, 'GET RULES')
  }
})

router.put('/', writeLimit, async (req, res) => {
  const rules = normalizeRules(req.body?.rules)
  if (!rules) return res.status(400).json({ ok: false, message: 'Invalid country rule settings' })
  try {
    const current = await supabase
      .from('shadow_country_settings')
      .select('revision')
      .eq('settings_key', 'default')
      .single()
    if (current.error) throw current.error
    const { data, error } = await supabase
      .from('shadow_country_settings')
      .update({ rules, revision: Number(current.data.revision) + 1, updated_at: new Date().toISOString() })
      .eq('settings_key', 'default')
      .eq('revision', current.data.revision)
      .select('rules,revision,updated_at')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(409).json({ ok: false, message: 'Settings changed elsewhere. Reload and try again' })
    await audit(req, 'COUNTRY_RULES_UPDATE', null, 'Country Rules', JSON.stringify({ revision: data.revision, rules: data.rules }))
    return res.json({ ok: true, rules: data.rules, revision: data.revision, updatedAt: data.updated_at })
  } catch (error) {
    return fail(res, error, 'UPDATE RULES')
  }
})

router.get('/users', readLimit, async (req, res) => {
  const search = cleanSearch(req.query.search)
  if (search.length < 2) return res.json({ ok: true, users: [] })
  try {
    let query = supabase.from('users').select('id,name,username,email,is_author').limit(LIMIT)
    if (UUID.test(search)) {
      query = query.eq('id', search)
    } else {
      const value = `%${search}%`
      query = query.or(`name.ilike.${value},username.ilike.${value},email.ilike.${value}`)
    }
    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    return res.json({
      ok: true,
      users: (data || []).map(user => ({
        id: user.id,
        name: user.name || user.username || 'Reader',
        username: user.username || '',
        email: user.email || '',
        isAuthor: Boolean(user.is_author),
      })),
    })
  } catch (error) {
    return fail(res, error, 'SEARCH USERS')
  }
})

router.get('/exceptions', readLimit, async (req, res) => {
  const page = Math.min(10000, Math.max(1, Number.parseInt(req.query.page, 10) || 1))
  const start = (page - 1) * LIMIT
  try {
    const { data, count, error } = await supabase
      .from('shadow_country_user_exceptions')
      .select('id,user_id,mode,overrides,expires_at,updated_at', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + LIMIT - 1)
    if (error) throw error
    const ids = [...new Set((data || []).map(item => item.user_id).filter(Boolean))]
    let users = []
    if (ids.length) {
      const result = await supabase.from('users').select('id,name,username,email').in('id', ids)
      if (result.error) throw result.error
      users = result.data || []
    }
    const usersById = new Map(users.map(user => [user.id, user]))
    const exceptions = (data || []).map(item => {
      const user = usersById.get(item.user_id)
      return {
        id: item.id,
        userId: item.user_id,
        userName: user?.name || user?.username || 'Reader',
        email: user?.email || '',
        mode: item.mode,
        overrides: item.overrides || {},
        expiresAt: item.expires_at,
        updatedAt: item.updated_at,
      }
    })
    return res.json({ ok: true, exceptions, total: count || 0, page, limit: LIMIT })
  } catch (error) {
    return fail(res, error, 'LIST EXCEPTIONS')
  }
})

router.post('/exceptions', writeLimit, async (req, res) => {
  const userId = String(req.body?.userId || '')
  const mode = String(req.body?.mode || '')
  if (!UUID.test(userId) || !EXCEPTION_MODES.includes(mode)) {
    return res.status(400).json({ ok: false, message: 'Invalid user exception' })
  }
  try {
    const [userResult, rulesResult, existingResult] = await Promise.all([
      supabase.from('users').select('id').eq('id', userId).maybeSingle(),
      supabase.from('shadow_country_settings').select('rules').eq('settings_key', 'default').single(),
      supabase.from('shadow_country_user_exceptions')
        .select('id,mode,overrides,expires_at').eq('user_id', userId).maybeSingle(),
    ])
    if (userResult.error) throw userResult.error
    if (rulesResult.error) throw rulesResult.error
    if (existingResult.error) throw existingResult.error
    if (!userResult.data) return res.status(404).json({ ok: false, message: 'Reader account not found' })

    // Resolve valid override keys from SAVED Country Rules, never from user-provided schema.
    const rules = normalizeRules(rulesResult.data?.rules)
    if (!rules) return res.status(503).json({ ok: false, message: 'Country Rules unavailable' })
    const overrides = mode === 'custom' ? normalizeOverrides(req.body?.overrides, rules) : {}
    if (overrides === null) {
      return res.status(400).json({ ok: false, message: 'Invalid user exception permissions' })
    }

    const { data, error } = await supabase
      .from('shadow_country_user_exceptions')
      .upsert({ user_id: userId, mode, overrides, expires_at: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select('id,user_id,mode,overrides,updated_at')
      .single()
    if (error) throw error

    const before = existingResult.data
      ? { mode: existingResult.data.mode, overrides: existingResult.data.overrides || {}, expiresAt: existingResult.data.expires_at }
      : null
    const after = { mode: data.mode, overrides: data.overrides || {}, expiresAt: null }
    await audit(req, before ? 'COUNTRY_EXCEPTION_UPDATE' : 'COUNTRY_EXCEPTION_CREATE', data.id,
      'Country User Exception', JSON.stringify({ userId, before, after }))
    return res.json({ ok: true, exception: data })
  } catch (error) {
    return fail(res, error, 'SAVE EXCEPTION')
  }
})

router.delete('/exceptions/:exceptionId', writeLimit, async (req, res) => {
  const id = String(req.params.exceptionId || '')
  if (!UUID.test(id)) return res.status(400).json({ ok: false, message: 'Invalid exception ID' })
  try {
    const { data, error } = await supabase
      .from('shadow_country_user_exceptions')
      .delete()
      .eq('id', id)
      .select('id,user_id,mode,overrides,expires_at')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Exception not found' })
    await audit(req, 'COUNTRY_EXCEPTION_REVOKE', data.id, 'Country User Exception', JSON.stringify({
      userId: data.user_id,
      before: { mode: data.mode, overrides: data.overrides || {}, expiresAt: data.expires_at },
      after: null,
    }))
    return res.json({ ok: true })
  } catch (error) {
    return fail(res, error, 'REVOKE EXCEPTION')
  }
})

export default router
