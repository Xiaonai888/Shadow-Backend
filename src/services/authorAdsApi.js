const FALLBACK_API = 'https://shadow-backend-kucw.onrender.com'
const API_ORIGIN = (
  import.meta.env.VITE_API_URL ||
  (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:5000'
    : FALLBACK_API)
).replace(/\/$/, '')
const BASE_PATH = `${API_ORIGIN}/api/author-ads/me/campaigns`
const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const CACHE_TTL_MS = 25000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CAMPAIGN_STATUSES = new Set([
  'all', 'draft', 'pending_review', 'approved', 'scheduled',
  'active', 'paused', 'completed', 'rejected', 'cancelled',
])
const cachedLists = new Map()
const activeLists = new Map()
let cacheGeneration = 0

export const AUTHOR_ADS_PAGE_SIZE = PAGE_SIZE

function getReaderToken() {
  return localStorage.getItem('shadow_reader_token') || sessionStorage.getItem('shadow_reader_token') || ''
}

function fingerprint(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  }
  return (hash >>> 0).toString(16)
}

function campaignId(value) {
  const id = String(value || '').trim()
  if (!UUID_PATTERN.test(id)) {
    const error = new Error('Invalid campaign ID')
    error.code = 'INVALID_CAMPAIGN_ID'
    throw error
  }
  return id
}

function boundedInt(value, fallback, minimum, maximum) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback
}

function invalidateCampaignCache() {
  cacheGeneration += 1
  cachedLists.clear()
  activeLists.clear()
}

async function authorAdRequest(url, { method = 'GET', data, signal } = {}) {
  const token = getReaderToken()
  if (!token) {
    const error = new Error('Author login required')
    error.code = 'AUTH_REQUIRED'
    throw error
  }
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    const missingRoute = response.status === 404 && !payload?.code
    const unconfigured = response.status === 503 && (!payload?.code || payload.code === 'AUTHOR_ADS_NOT_CONFIGURED')
    const error = new Error(
      missingRoute || unconfigured
        ? 'Author Ads is not connected yet'
        : String(payload?.message || `Author Ads request failed (${response.status})`).slice(0, 200)
    )
    error.code = payload?.code || (missingRoute || unconfigured
      ? 'AUTHOR_ADS_NOT_CONFIGURED'
      : 'AUTHOR_ADS_REQUEST_FAILED')
    error.status = response.status
    throw error
  }
  return payload
}

export function normalizeAuthorAdDraft(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Invalid draft')
  }
  const kind = String(source.kind || '').trim()
  const contentType = String(source.contentType || source.content_type || '').trim()
  const contentId = campaignId(source.contentId || source.content_id)
  const goal = String(source.goal || '').trim()
  const durationDays = Number(source.durationDays ?? source.duration_days)
  const budgetUsd = Number(source.budgetUsd ?? source.budget_usd)
  const audience = source.audience && typeof source.audience === 'object' && !Array.isArray(source.audience)
    ? source.audience
    : {}
  const mode = String(audience.mode || source.audience_mode || 'automatic').trim()

  if (!['post', 'book'].includes(kind) ||
      (kind === 'post' && contentType !== 'post') ||
      (kind === 'book' && !['story', 'product'].includes(contentType))) {
    const error = new Error('Invalid Boost type')
    error.code = 'INVALID_CONTENT_TYPE'
    throw error
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd < 1 || budgetUsd > 10000 ||
      Math.round(budgetUsd * 100) / 100 !== budgetUsd) {
    const error = new Error('Budget must be between $1 and $10,000 with at most two decimals')
    error.code = 'INVALID_BUDGET'
    throw error
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) {
    const error = new Error('Duration must be between 1 and 30 days')
    error.code = 'INVALID_DURATION'
    throw error
  }
  if (!['automatic', 'manual'].includes(mode)) {
    const error = new Error('Invalid audience mode')
    error.code = 'INVALID_AUDIENCE'
    throw error
  }

  return {
    kind,
    contentType,
    contentId,
    goal,
    audience: {
      mode,
      genre: mode === 'manual' ? String(audience.genre || '').trim() : '',
      language: mode === 'manual' ? String(audience.language || '').trim().toLowerCase() : '',
      country: mode === 'manual' ? String(audience.country || '').trim().toUpperCase() : '',
    },
    budgetUsd: budgetUsd.toFixed(2),
    durationDays,
    placements: ['discover'],
  }
}

export function clearAuthorAdsListCache() {
  invalidateCampaignCache()
}

export async function listAuthorAdCampaigns({
  page = 1,
  limit = PAGE_SIZE,
  status = 'all',
  signal,
  refresh = false,
} = {}) {
  if (refresh) invalidateCampaignCache()
  const selectedPage = boundedInt(page, 1, 1, 10000)
  const selectedLimit = boundedInt(limit, PAGE_SIZE, 1, MAX_PAGE_SIZE)
  const selectedStatus = CAMPAIGN_STATUSES.has(status) ? status : 'all'
  const query = new URLSearchParams({
    page: String(selectedPage),
    limit: String(selectedLimit),
    status: selectedStatus,
  })
  const token = getReaderToken()
  if (!token) {
    const error = new Error('Author login required')
    error.code = 'AUTH_REQUIRED'
    throw error
  }
  const key = `${cacheGeneration}:${fingerprint(token)}:${query}`
  if (!refresh) {
    const saved = cachedLists.get(key)
    if (saved && Date.now() - saved.savedAt < CACHE_TTL_MS) return saved.data
    if (!signal && activeLists.has(key)) return activeLists.get(key)
  }

  const execute = async () => {
    const result = await authorAdRequest(`${BASE_PATH}?${query}`, { signal })
    if (!Array.isArray(result.campaigns) || !Number.isFinite(Number(result.total)) ||
        result.campaigns.length > selectedLimit) {
      const error = new Error('Invalid campaign page response')
      error.code = 'INVALID_CAMPAIGN_RESPONSE'
      throw error
    }
    const normalized = {
      campaigns: result.campaigns,
      total: Math.max(0, Number(result.total)),
      page: selectedPage,
      limit: selectedLimit,
      has_more: Boolean(result.has_more),
    }
    if (key.startsWith(`${cacheGeneration}:`)) {
      if (cachedLists.size >= 40) cachedLists.clear()
      cachedLists.set(key, { data: normalized, savedAt: Date.now() })
    }
    return normalized
  }

  if (signal) return execute()
  const promise = execute().finally(() => activeLists.delete(key))
  activeLists.set(key, promise)
  return promise
}

export async function getAuthorAdCampaign(id, { signal } = {}) {
  const result = await authorAdRequest(`${BASE_PATH}/${encodeURIComponent(campaignId(id))}`, { signal })
  if (!result.campaign || typeof result.campaign !== 'object') {
    const error = new Error('Invalid campaign detail response')
    error.code = 'INVALID_CAMPAIGN_RESPONSE'
    throw error
  }
  return result.campaign
}

export async function createAuthorAdDraft(draft, { signal } = {}) {
  const result = await authorAdRequest(BASE_PATH, {
    method: 'POST', data: normalizeAuthorAdDraft(draft), signal,
  })
  invalidateCampaignCache()
  return result.campaign
}

export async function updateAuthorAdDraft(id, draft, { signal } = {}) {
  const result = await authorAdRequest(`${BASE_PATH}/${encodeURIComponent(campaignId(id))}`, {
    method: 'PUT', data: normalizeAuthorAdDraft(draft), signal,
  })
  invalidateCampaignCache()
  return result.campaign
}

export async function deleteAuthorAdDraft(id, { signal } = {}) {
  const result = await authorAdRequest(`${BASE_PATH}/${encodeURIComponent(campaignId(id))}`, {
    method: 'DELETE', signal,
  })
  invalidateCampaignCache()
  return result.deleted_id
}

export async function submitAuthorAdForReview(id, { signal } = {}) {
  const result = await authorAdRequest(`${BASE_PATH}/${encodeURIComponent(campaignId(id))}/submit`, {
    method: 'POST', signal,
  })
  invalidateCampaignCache()
  return result.campaign
}
