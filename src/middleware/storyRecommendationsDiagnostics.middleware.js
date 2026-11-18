import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const MAX_LOGS_PER_MINUTE = 8
let logMinute = -1
const loggedSignatures = new Set()

function failureCode(body, status) {
  const rawCode = String(body?.code || body?.error?.code || '').trim().toUpperCase()
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode)) return rawCode

  const description = [body?.error?.message, body?.error, body?.message]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .slice(0, 1000)
  const databaseCode = description.match(/\b(?:PGRST\d{3}|42P01|42703|42501|57014|53300|22P02|08P01|XX000)\b/i)
  if (databaseCode) return databaseCode[0].toUpperCase()
  if (/timeout|timed out|statement timeout/i.test(description)) return 'RECOMMENDATIONS_TIMEOUT'
  if (/permission denied|row.level security/i.test(description)) return 'RECOMMENDATIONS_PERMISSION_DENIED'
  if (/fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(description)) return 'RECOMMENDATIONS_NETWORK_ERROR'
  return `RECOMMENDATIONS_HTTP_${status}`
}

export function traceStoryRecommendationFailures(req, res, next) {
  const startedAt = Date.now()
  let recorded = false

  const record = (body, responseKind) => {
    const status = Number(res.statusCode || 0)
    if (recorded || status < 400 || status >= 600) return
    recorded = true

    const cacheState = String(res.getHeader('X-Shadow-Recommendations-Cache') || 'NONE').toUpperCase()
    const stage = cacheState === 'MISS'
      ? 'origin_pipeline'
      : cacheState === 'WAIT'
        ? 'inflight_wait'
        : cacheState === 'HIT'
          ? 'cached_response'
          : 'before_cache_or_unhandled'
    const code = failureCode(body, status)

    markRequestDiagnostic({
      feature: 'story_recommendations',
      stage,
      cache_state: cacheState,
      error_code: code,
      response_status: status,
      response_kind: responseKind,
    })

    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== logMinute) {
      logMinute = minute
      loggedSignatures.clear()
    }

    const signature = `${status}:${stage}:${code}`
    if (loggedSignatures.has(signature) || loggedSignatures.size >= MAX_LOGS_PER_MINUTE) return
    loggedSignatures.add(signature)

    console.warn('STORY_RECOMMENDATIONS_FAILURE', JSON.stringify({
      status,
      stage,
      cache_state: cacheState,
      error_code: code,
      response_kind: responseKind,
      elapsed_ms: Date.now() - startedAt,
    }))
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    record(body, 'json')
    return originalJson(body)
  }

  const originalEnd = res.end.bind(res)
  res.end = (...args) => {
    record(null, 'non_json')
    return originalEnd(...args)
  }

  return next()
}
