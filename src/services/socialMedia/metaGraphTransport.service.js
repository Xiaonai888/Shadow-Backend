import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

export class MetaPublishingError extends Error {
  constructor(code, { uncertain = false, status = null, metaCode = null } = {}) {
    super(code)
    this.name = 'MetaPublishingError'
    this.code = code
    this.uncertain = uncertain
    this.status = status
    this.metaCode = metaCode
  }
}

export function metaId(value, code = 'SOCIAL_META_ID_INVALID') {
  if (typeof value !== 'string' || !/^[0-9]{1,40}$/.test(value)) throw new MetaPublishingError(code)
  return value
}

export function metaPhotoUrl(value, { jpegOnly = false } = {}) {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error()
    const u = new URL(value)
    const host = u.hostname.toLowerCase()
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !host.includes('.') || isIP(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) throw new Error()
    if (jpegOnly && !/\.jpe?g$/i.test(u.pathname)) throw new MetaPublishingError('SOCIAL_IG_JPEG_REQUIRED')
    return u.href
  } catch (error) {
    if (error instanceof MetaPublishingError) throw error
    throw new MetaPublishingError('SOCIAL_META_PHOTO_INVALID')
  }
}

export function validateMetaPhotoPost(post, platform, { jpegOnly = false } = {}) {
  if (post?.platform !== platform || !['photo','carousel'].includes(post.mediaType) || !Array.isArray(post.photos) || typeof post.caption !== 'string' || !post.caption.trim() || post.caption.length > 2200) throw new MetaPublishingError('SOCIAL_META_POST_INVALID')
  if (post.mediaType === 'photo' ? post.photos.length !== 1 : post.photos.length < 3 || post.photos.length > 5) throw new MetaPublishingError('SOCIAL_META_PHOTO_COUNT')
  const photos = post.photos.map(value => metaPhotoUrl(value, { jpegOnly }))
  if (new Set(photos).size !== photos.length) throw new MetaPublishingError('SOCIAL_META_PHOTO_DUPLICATE')
  return { photos, caption: post.caption }
}

export async function requestMetaGraph({ path, token, params = {}, method = 'GET', fetchImpl = globalThis.fetch }) {
  const version = process.env.SOCIAL_META_GRAPH_VERSION || ''
  const secret = process.env.SOCIAL_META_APP_SECRET || ''
  if (!/^v[1-9][0-9]*\.[0-9]+$/.test(version) || !secret) throw new MetaPublishingError('SOCIAL_META_CONFIG_MISSING')
  if (typeof token !== 'string' || !token || token.length > 16384 || /\s/.test(token)) throw new MetaPublishingError('SOCIAL_META_TOKEN_INVALID')
  if (typeof path !== 'string' || !/^(?:me|[0-9]{1,40})(?:\/(?:photos|feed|media|media_publish))?$/.test(path) || !['GET','POST'].includes(method)) throw new MetaPublishingError('SOCIAL_META_PATH_INVALID')
  if (typeof fetchImpl !== 'function' || !params || Object.hasOwn(params,'access_token') || Object.hasOwn(params,'appsecret_proof')) throw new MetaPublishingError('SOCIAL_META_REQUEST_INVALID')
  const proof = createHmac('sha256', secret).update(token).digest('hex')
  const form = new URLSearchParams({ ...params, appsecret_proof: proof })
  const url = new URL(`https://graph.facebook.com/${version}/${path}`)
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  const init = { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000) }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    init.body = form
  } else url.search = form.toString()
  let response, data
  try {
    response = await fetchImpl(url, init)
    data = await response.json()
  } catch {
    throw new MetaPublishingError('SOCIAL_META_RESPONSE_UNKNOWN', { uncertain: method === 'POST' })
  }
  if (!response.ok || data?.error) {
    const status = response.status
    const metaCode = Number.isSafeInteger(data?.error?.code) ? data.error.code : null
    throw new MetaPublishingError('SOCIAL_META_REQUEST_FAILED', { status, metaCode, uncertain: method === 'POST' && (status >= 500 || status === 408 || status === 429 || !data?.error) })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MetaPublishingError('SOCIAL_META_RESPONSE_UNKNOWN', { uncertain: method === 'POST' })
  return data
}

export function metaCreatedId(data, { post = false } = {}) {
  const id = data?.id
  const pattern = post ? /^[0-9]{1,40}(?:_[0-9]{1,40})?$/ : /^[0-9]{1,40}$/
  if (typeof id !== 'string' || !pattern.test(id)) throw new MetaPublishingError('SOCIAL_META_CREATED_ID_UNKNOWN', { uncertain: true })
  return id
}
