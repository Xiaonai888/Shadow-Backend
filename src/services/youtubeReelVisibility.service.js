const ID_RE = /^[A-Za-z0-9_-]{11}$/
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])
const CACHE_MAX = 3000
const LIVE_TTL = 15 * 60 * 1000
const GONE_TTL = 5 * 60 * 1000
const ERROR_TTL = 60 * 1000
const cache = new Map()
const pending = new Map()

function videoId(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (!HOSTS.has(host)) return ''
    const segments = url.pathname.split('/').filter(Boolean)
    let id = ''
    if (host === 'youtu.be' || host === 'www.youtu.be') id = segments[0] || ''
    else if (segments[0] === 'watch') id = url.searchParams.get('v') || ''
    else if (['shorts', 'embed', 'live'].includes(segments[0])) id = segments[1] || ''
    return ID_RE.test(id) ? id : ''
  } catch {
    return ''
  }
}

function known(id) {
  const entry = cache.get(id)
  if (!entry) return undefined
  if (entry.until <= Date.now()) {
    cache.delete(id)
    return undefined
  }
  return entry.available
}

function remember(id, available) {
  const ttl = available === false ? GONE_TTL : available === true ? LIVE_TTL : ERROR_TTL
  cache.delete(id)
  cache.set(id, { available, until: Date.now() + ttl })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

async function checkGoogle(ids, key) {
  const params = new URLSearchParams({ part: 'status', id: ids.join(','), key })
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
    signal: AbortSignal.timeout(4000),
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error('Youtube availability lookup unavailable')
  const body = await response.json()
  if (!Array.isArray(body.items)) throw new Error('Invalid Youtube availability response')
  const live = new Set(body.items.filter(item =>
    ID_RE.test(String(item.id || '')) &&
    item.status?.privacyStatus !== 'private' &&
    item.status?.uploadStatus !== 'deleted' &&
    item.status?.embeddable !== false
  ).map(item => item.id))
  return new Map(ids.map(id => [id, live.has(id)]))
}

async function checkOembed(id) {
  try {
    const source = `https://www.youtube.com/watch?v=${id}`
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(source)}&format=json`
    const response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'follow' })
    if (response.status === 404 || response.status === 410) return false
    if (response.ok) return true
    return null
  } catch {
    return null
  }
}

async function checkOembedBatch(ids) {
  const results = new Map()
  let cursor = 0
  const count = Math.min(6, ids.length)
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor]
      cursor += 1
      results.set(id, await checkOembed(id))
    }
  }))
  return results
}

async function statuses(ids) {
  const valid = [...new Set(ids.filter(id => ID_RE.test(id)))].slice(0, 50)
  const newIds = valid.filter(id => known(id) === undefined && !pending.has(id))
  if (newIds.length) {
    const key = process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || ''
    const task = (key ? checkGoogle(newIds, key).catch(() => checkOembedBatch(newIds)) : checkOembedBatch(newIds)).catch(() => new Map())
    for (const id of newIds) {
      const single = task.then(results => {
        const available = results.has(id) ? results.get(id) : null
        remember(id, available)
        return available
      }).finally(() => pending.delete(id))
      pending.set(id, single)
    }
  }
  const resolved = await Promise.all(valid.map(async id => {
    const ready = known(id)
    const available = ready === undefined ? await pending.get(id) : ready
    return [id, available]
  }))
  return new Map(resolved)
}

export async function filterLiveYoutubeReels(rows) {
  if (!Array.isArray(rows) || !rows.length) return []
  const ids = rows.map(row => videoId(row.video_url))
  const available = await statuses(ids)
  return rows.filter((row, i) => !ids[i] || available.get(ids[i]) !== false)
}

export async function isLiveYoutubeReel(url) {
  const id = videoId(url)
  if (!id) return false
  const state = await statuses([id])
  return state.get(id) !== false
}
