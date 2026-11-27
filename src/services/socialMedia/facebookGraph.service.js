import { createHmac } from 'node:crypto'

export class FacebookGraphError extends Error {
  constructor(code, { uncertain = false, status = null, metaCode = null } = {}) {
    super(code)
    this.name = 'FacebookGraphError'
    this.code = code
    this.uncertain = uncertain
    this.status = status
    this.metaCode = metaCode
  }
}

function config() {
  const version = process.env.SOCIAL_META_GRAPH_VERSION || ''
  const secret = process.env.SOCIAL_META_APP_SECRET || ''
  if (!/^v[1-9][0-9]*\.[0-9]+$/.test(version) || !secret) throw new FacebookGraphError('SOCIAL_META_CONFIG_MISSING')
  return { version, secret }
}

function validateToken(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 16384 || /\s/.test(token)) throw new FacebookGraphError('SOCIAL_META_TOKEN_INVALID')
}

function publicHttps(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')) throw new Error()
    return url.href
  } catch {
    throw new FacebookGraphError('SOCIAL_META_URL_INVALID')
  }
}

async function graphRequest({ path, token, params = {}, method = 'GET', fetchImpl = globalThis.fetch }) {
  validateToken(token)
  const { version, secret } = config()
  const proof = createHmac('sha256', secret).update(token).digest('hex')
  const url = new URL(`https://graph.facebook.com/${version}/${path}`)
  const form = new URLSearchParams({ ...params, appsecret_proof: proof })
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  const init = { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000) }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    init.body = form
  } else {
    url.search = form.toString()
  }
  let response
  let data
  try {
    response = await fetchImpl(url, init)
    data = await response.json()
  } catch {
    throw new FacebookGraphError('SOCIAL_META_RESPONSE_UNKNOWN', { uncertain: method === 'POST' })
  }
  if (!response.ok || data?.error) {
    const status = response.status
    const metaCode = Number.isSafeInteger(data?.error?.code) ? data.error.code : null
    const uncertain = method === 'POST' && (status >= 500 || status === 408 || status === 429 || !data?.error)
    throw new FacebookGraphError('SOCIAL_META_REQUEST_FAILED', { status, metaCode, uncertain })
  }
  return data
}

export async function verifyFacebookPage({ pageId, pageToken, fetchImpl }) {
  if (typeof pageId !== 'string' || !/^[0-9]{1,40}$/.test(pageId)) throw new FacebookGraphError('SOCIAL_META_PAGE_INVALID')
  const data = await graphRequest({ path: 'me', token: pageToken, params: { fields: 'id,name' }, fetchImpl })
  if (String(data?.id) !== pageId || typeof data?.name !== 'string' || !data.name.trim()) throw new FacebookGraphError('SOCIAL_META_PAGE_MISMATCH')
  return { pageId, name: data.name }
}

export async function publishFacebookPagePost({ pageId, pageToken, message, link, photoUrl, fetchImpl }) {
  if (typeof pageId !== 'string' || !/^[0-9]{1,40}$/.test(pageId)) throw new FacebookGraphError('SOCIAL_META_PAGE_INVALID')
  if (typeof message !== 'string' || !message.trim() || Array.from(message).length > 60000) throw new FacebookGraphError('SOCIAL_META_MESSAGE_INVALID')
  if (photoUrl && link) throw new FacebookGraphError('SOCIAL_META_POST_FORMAT_INVALID')
  const params = { published: 'true' }
  let edge = 'feed'
  if (photoUrl) {
    edge = 'photos'
    params.url = publicHttps(photoUrl)
    params.caption = message
  } else {
    params.message = message
    if (link) params.link = publicHttps(link)
  }
  const data = await graphRequest({ path: `${pageId}/${edge}`, token: pageToken, method: 'POST', params, fetchImpl })
  const postId = edge === 'photos' ? data?.post_id : data?.id
  if (typeof postId !== 'string' || !/^[0-9_]{1,100}$/.test(postId)) throw new FacebookGraphError('SOCIAL_META_POST_ID_UNKNOWN', { uncertain: true })
  return { postId }
}
