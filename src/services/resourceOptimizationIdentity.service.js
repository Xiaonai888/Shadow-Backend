import { createHmac, randomBytes } from 'node:crypto'

const secret = randomBytes(32)
const MAX_INPUT = 8192
const SAFE_HTTP = [
  [/^\/api\/public\/stories\/?$/, '/api/public/stories'],
  [/^\/api\/public\/stories\/[^/]+\/episodes\/?$/, '/api/public/stories/:id/episodes'],
  [/^\/api\/public\/stories\/[^/]+\/recommendations\/?$/, '/api/public/stories/:id/recommendations'],
  [/^\/api\/public\/stories\/[^/]+\/?$/, '/api/public/stories/:id'],
  [/^\/api\/reading-progress\/?$/, '/api/reading-progress'],
]
const SAFE_PAGES = new Set(['stories', 'manga', 'chat-story', 'chat-stories', 'chatstory', 'chatstories', 'discover', 'genre', 'genres', 'mine', 'me', 'library', 'author', 'reader', 'search', 'fast', 'reel', 'reels', 'shop', 'shadow-mall', 'mall', 'task-center', 'taskcenter', 'system-control', 'resource-cost', 'resource-and-cost'])

function fingerprint(parts) {
  const input = JSON.stringify(parts)
  if (input.length > MAX_INPUT) return null
  return createHmac('sha256', secret).update(input).digest('hex')
}

function header(headers, name) {
  return String(headers?.get?.(name) ?? headers?.[name] ?? '')
}

function boundedHeaders(headers, ignored) {
  const source = typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {})
  const result = []
  let size = 0
  for (const [rawName, rawValue] of source) {
    const name = String(rawName).toLowerCase()
    if (ignored.has(name)) continue
    const value = String(rawValue ?? '')
    size += name.length + value.length
    if (size > MAX_INPUT || result.length >= 64) return null
    result.push([name, value])
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}

const IGNORE_HTTP = new Set(['x-shadow-page', 'x-shadow-visibility', 'referer', 'traceparent', 'tracestate', 'x-request-id', 'cf-ray', 'x-forwarded-for', 'x-forwarded-port', 'x-forwarded-proto', 'cf-connecting-ip'])
const IGNORE_DB = new Set(['traceparent', 'tracestate', 'x-request-id'])

export function optimizationPage(value) {
  const match = /^(WEB|ADMIN):\/(.*)$/i.exec(String(value || '').slice(0, 200))
  if (!match) return 'UNATTRIBUTED'
  const prefix = match[1].toUpperCase()
  const segment = match[2].split('/')[0].toLowerCase()
  return `${prefix}:/${!segment ? '' : SAFE_PAGES.has(segment) ? segment : ':other'}`
}

export function optimizationHttpIdentity(req) {
  if (String(req?.method || '').toUpperCase() !== 'GET') return null
  const raw = String(req.originalUrl || req.url || '')
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > MAX_INPUT) return null
  let url
  try { url = new URL(raw, 'http://shadow.invalid') } catch { return null }
  const match = SAFE_HTTP.find(([pattern]) => pattern.test(url.pathname))
  if (!match) return null
  const authorization = header(req.headers, 'authorization')
  const visitor = header(req.headers, 'x-shadow-visitor-id')
  if (!/^Bearer\s+\S+$/i.test(authorization) && !/^[a-z0-9_-]{8,100}$/i.test(visitor)) return null
  if (authorization && !/^Bearer\s+\S+$/i.test(authorization)) return null
  const headers = boundedHeaders(req.headers, IGNORE_HTTP)
  if (!headers) return null
  const key = fingerprint([raw, headers])
  return key ? { key, route: `GET ${match[1]}` } : null
}

export function optimizationSupabaseIdentity({ url, method, headers, context } = {}) {
  if (!context || String(method || '').toUpperCase() !== 'GET') return null
  const raw = String(url || '')
  if (raw.length > MAX_INPUT) return null
  let target
  try { target = new URL(raw) } catch { return null }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) return null
  if (!/^\/rest\/v1\/[a-z][a-z0-9_]{0,79}$/.test(target.pathname)) return null
  const selected = boundedHeaders(headers, IGNORE_DB)
  if (!selected) return null
  const key = fingerprint([raw, selected])
  return key ? { key, route: `GET ${target.pathname}` } : null
}
