import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getAdminActor } from '../services/adminActivity.service.js'

const router = express.Router()
const LIMIT = 10
const MAX_READ_ROWS = 600
const STORY_CHUNK = 150
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COUNTRIES_INVALID = new Set(['XX', 'ZZ', 'T1'])
const GROUPS = new Set(['all', 'kh', 'international', 'unknown'])
const KHMER_LANGUAGES = new Set(['km', 'kh', 'khmer'])

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

function safeCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return validCountry(code) ? code : null
}

function fail(res, error, label) {
  console.error(`READER CLASSIFICATION ${label}:`, error)
  return res.status(503).json({ ok: false, message: 'Reader Classification data is temporarily unavailable' })
}

async function loadReadingEvidence(userIds) {
  const empty = new Map(userIds.map(id => [id, null]))
  if (!userIds.length) return empty

  try {
    const { data: progress, error: progressError } = await supabase
      .from('reading_progress')
      .select('user_id,story_id,episode_id')
      .in('user_id', userIds)
      .limit(MAX_READ_ROWS + 1)

    if (progressError) throw progressError
    if ((progress || []).length > MAX_READ_ROWS) return empty

    const storyIds = [...new Set((progress || []).map(row => String(row.story_id || '')).filter(id => UUID.test(id)))]
    const storyLanguages = new Map()
    for (let start = 0; start < storyIds.length; start += STORY_CHUNK) {
      const { data: stories, error: storyError } = await supabase
        .from('stories')
        .select('id,story_language')
        .in('id', storyIds.slice(start, start + STORY_CHUNK))
      if (storyError) throw storyError
      for (const story of stories || []) {
        storyLanguages.set(String(story.id), String(story.story_language || '').trim().toLowerCase())
      }
    }

    const perUser = new Map(userIds.map(id => [id, {
      khmerStories: new Set(),
      internationalStories: new Set(),
      khmerEpisodes: new Set(),
      internationalEpisodes: new Set(),
    }]))

    for (const progressRow of progress || []) {
      const user = perUser.get(String(progressRow.user_id || ''))
      const storyId = String(progressRow.story_id || '')
      const language = storyLanguages.get(storyId)
      if (!user || !language) continue
      const khmer = KHMER_LANGUAGES.has(language)
      const episodeId = String(progressRow.episode_id || '')
      if (khmer) {
        user.khmerStories.add(storyId)
        if (episodeId) user.khmerEpisodes.add(episodeId)
      } else {
        user.internationalStories.add(storyId)
        if (episodeId) user.internationalEpisodes.add(episodeId)
      }
    }

    return new Map(userIds.map(id => {
      const value = perUser.get(id)
      const khmerStories = value.khmerStories.size
      const internationalStories = value.internationalStories.size
      const khmerEpisodes = value.khmerEpisodes.size
      const internationalEpisodes = value.internationalEpisodes.size
      const totalEpisodes = khmerEpisodes + internationalEpisodes
      const totalStories = khmerStories + internationalStories
      const inferredGroup = totalStories >= 3
        ? khmerStories >= internationalStories ? 'kh' : 'international'
        : 'unknown'
      return [id, {
        khmer_stories: khmerStories,
        international_stories: internationalStories,
        khmer_episodes: khmerEpisodes,
        total_episodes: totalEpisodes,
        khmer_read_percent: totalEpisodes ? khmerEpisodes / totalEpisodes * 100 : null,
        inferred_group: inferredGroup,
      }]
    }))
  } catch (error) {
    console.warn('READER CLASSIFICATION READING EVIDENCE:', error?.message || error)
    return empty
  }
}

function mapReader(user, record, evidence) {
  const detected = safeCode(record?.detected_country)
  const override = safeCode(record?.admin_country_override)
  const groupOverride = ['kh', 'international'].includes(record?.admin_group_override)
    ? record.admin_group_override
    : null
  const group = groupOverride || evidence?.inferred_group || 'unknown'
  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    joined_at: user.created_at,
    detected_country: detected,
    effective_country: override || detected,
    admin_country_override: override,
    admin_group_override: groupOverride,
    reader_group: group,
    classification_source: groupOverride || override
      ? 'admin_override'
      : evidence?.inferred_group && evidence.inferred_group !== 'unknown'
        ? 'story_language'
        : detected ? 'ip_country' : 'unknown',
    khmer_stories: evidence?.khmer_stories ?? null,
    international_stories: evidence?.international_stories ?? null,
    khmer_episodes: evidence?.khmer_episodes ?? null,
    total_episodes: evidence?.total_episodes ?? null,
    khmer_read_percent: evidence?.khmer_read_percent ?? null,
  }
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
    let request = supabase.from('users')
      .select('id,name,username,created_at', { count: search || group !== 'all' ? undefined : 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(requestedLimit)

    if (search) {
      request = UUID.test(search)
        ? request.eq('id', search)
        : request.or(`name.ilike.%${search}%,username.ilike.%${search}%`)
    }

    const { data: users, error: usersError, count: userCount } = await request
    if (usersError) throw usersError
    const userIds = (users || []).map(user => String(user.id))
    let classified = []
    if (userIds.length) {
      const { data, error } = await supabase
        .from('shadow_reader_classifications')
        .select('user_id,detected_country,detected_source,admin_country_override,admin_group_override')
        .in('user_id', userIds)
      if (error) throw error
      classified = data || []
    }

    const byId = new Map(classified.map(row => [String(row.user_id), row]))
    const reading = await loadReadingEvidence(userIds)
    const allRows = (users || []).map(user => mapReader(user, byId.get(String(user.id)), reading.get(String(user.id))))
    const items = group === 'all' ? allRows : allRows.filter(item => item.reader_group === group)

    return res.json({
      ok: true,
      items,
      has_next: false,
      page: 1,
      limit: requestedLimit,
      summary: {
        total: !search && group === 'all' ? userCount : null,
        kh: null,
        international: null,
        unknown: null,
        khmer_episodes: null,
        international_episodes: null,
      },
    })
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

  const countryRaw = body.admin_country_override
  const groupRaw = body.admin_group_override
  const country = countryRaw === null || countryRaw === '' ? null : String(countryRaw || '').trim().toUpperCase()
  const group = groupRaw === null || groupRaw === '' ? null : groupRaw
  if (country !== null && !validCountry(country)) return res.status(400).json({ ok: false, message: 'Invalid country code' })
  if (group !== null && !['kh', 'international'].includes(group)) return res.status(400).json({ ok: false, message: 'Invalid reader group' })

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
