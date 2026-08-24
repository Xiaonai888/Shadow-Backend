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

function getSearcherContext(req) {
  const token = getBearerToken(req)
  let readerId = ''

  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)

      if (decoded?.type === 'reader' && decoded?.user_id) {
        readerId = String(decoded.user_id).trim().slice(0, 160)
      }
    } catch {
    }
  }

  const identity = readerId
    ? `reader:${readerId}`
    : [
        'anonymous',
        new Date().toISOString().slice(0, 10),
        getClientIp(req),
        String(req?.headers?.['user-agent'] || '').slice(0, 300),
      ].join(':')

  const secret =
    process.env.SEARCH_ANALYTICS_HASH_SALT ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!secret) {
    return {
      readerId: readerId || null,
      searcherHash: '',
    }
  }

  return {
    readerId: readerId || null,
    searcherHash: crypto
      .createHmac('sha256', secret)
      .update(identity)
      .digest('hex'),
  }
}

export async function recordSearchAnalytics({
  req,
  keyword,
  type,
  resultCount,
}) {
  const displayTerm = cleanDisplayTerm(keyword)
  const normalizedTerm = normalizeSearchTerm(keyword)
  const searchType = normalizeSearchType(type)
  const safeResultCount = Math.min(
    1000,
    Math.max(0, Number.parseInt(resultCount, 10) || 0)
  )
  const { readerId, searcherHash } = getSearcherContext(req)

  if (normalizedTerm.length < 2 || !searcherHash) {
    return {
      counted: false,
      reason: 'invalid_search',
    }
  }

  const { data, error } = await supabase.rpc(
    'record_search_analytics_event',
    {
      p_display_term: displayTerm,
      p_normalized_term: normalizedTerm,
      p_search_type: searchType,
      p_searcher_hash: searcherHash,
      p_result_count: safeResultCount,
      p_reader_id: readerId,
    }
  )

  if (error) throw error

  return data || {
    counted: false,
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
  const searchType = normalizeSearchType(type)
  const clickedType = normalizeSearchType(resultType)
  const clickedId = String(resultId || '').trim().slice(0, 160)
  const { searcherHash } = getSearcherContext(req)

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

  const { data, error } = await supabase.rpc(
    'record_search_analytics_click',
    {
      p_normalized_term: normalizedTerm,
      p_search_type: searchType,
      p_searcher_hash: searcherHash,
      p_target_key: `${clickedType}:${clickedId}`,
    }
  )

  if (error) throw error

  return data || {
    counted: false,
  }
}
