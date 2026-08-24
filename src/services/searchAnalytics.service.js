import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const VALID_SEARCH_TYPES = new Set([
  'all',
  'readers',
  'pages',
  'stories',
  'pdfs',
  'posts',
])

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000
let lastPurgeAt = 0

function cleanDisplayTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function normalizeSearchTerm(value) {
  return cleanDisplayTerm(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s#&+'_-]/gu, ' ')
    .replace(/[\s_-]+/g, ' ')
    .trim()
    .slice(0, 120)
}

function normalizeSearchType(value) {
  const type = String(value || 'all').trim().toLowerCase()
  return VALID_SEARCH_TYPES.has(type) ? type : 'all'
}

function getBearerToken(req) {
  const header = String(req?.headers?.authorization || '')
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()

  return forwarded || String(req?.ip || req?.socket?.remoteAddress || '')
}

function getSearcherIdentity(req) {
  const token = getBearerToken(req)

  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)

      if (decoded?.type === 'reader' && decoded?.user_id) {
        return `reader:${String(decoded.user_id)}`
      }
    } catch {
    }
  }

  const day = new Date().toISOString().slice(0, 10)
  const ip = getClientIp(req)
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 300)

  return `anonymous:${day}:${ip}:${userAgent}`
}

function hashSearcher(req) {
  const secret =
    process.env.SEARCH_ANALYTICS_HASH_SALT ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!secret) return ''

  return crypto
    .createHmac('sha256', secret)
    .update(getSearcherIdentity(req))
    .digest('hex')
}

async function maybePurgeSearchAnalytics() {
  const now = Date.now()

  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return

  lastPurgeAt = now

  const { error } = await supabase.rpc('purge_search_analytics')

  if (error) {
    lastPurgeAt = 0
    throw error
  }
}

export async function recordSearchAnalytics({
  req,
  keyword,
  type,
  resultCount,
}) {
  try {
    const displayTerm = cleanDisplayTerm(keyword)
    const normalizedTerm = normalizeSearchTerm(keyword)
    const searcherHash = hashSearcher(req)
    const searchType = normalizeSearchType(type)
    const safeResultCount = Math.max(
      0,
      Number.parseInt(resultCount, 10) || 0
    )

    if (normalizedTerm.length < 2 || !searcherHash) return

    const { error } = await supabase.rpc(
      'record_search_analytics_event',
      {
        p_display_term: displayTerm,
        p_normalized_term: normalizedTerm,
        p_search_type: searchType,
        p_searcher_hash: searcherHash,
        p_result_count: safeResultCount,
      }
    )

    if (error) throw error

    void maybePurgeSearchAnalytics().catch((purgeError) => {
      console.error(
        'SEARCH ANALYTICS PURGE ERROR:',
        purgeError?.message || purgeError
      )
    })
  } catch (error) {
    console.error(
      'SEARCH ANALYTICS RECORD ERROR:',
      error?.message || error
    )
  }
}

export async function recordSearchClick({
  req,
  keyword,
  type,
  resultType,
  resultId,
}) {
  const normalizedTerm = normalizeSearchTerm(keyword)
  const searcherHash = hashSearcher(req)
  const searchType = normalizeSearchType(type)
  const clickedType = normalizeSearchType(resultType)
  const clickedId = String(resultId || '').trim().slice(0, 160)

  if (
    normalizedTerm.length < 2 ||
    !searcherHash ||
    !clickedId ||
    clickedType === 'all'
  ) {
    return {
      counted: false,
      reason: 'invalid_click',
    }
  }

  const targetKey = `${clickedType}:${clickedId}`

  const { data, error } = await supabase.rpc(
    'record_search_analytics_click',
    {
      p_normalized_term: normalizedTerm,
      p_search_type: searchType,
      p_searcher_hash: searcherHash,
      p_target_key: targetKey,
    }
  )

  if (error) throw error

  void maybePurgeSearchAnalytics().catch((purgeError) => {
    console.error(
      'SEARCH ANALYTICS PURGE ERROR:',
      purgeError?.message || purgeError
    )
  })

  return data || {
    counted: false,
  }
}
