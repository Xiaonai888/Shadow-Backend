const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
])

export function studioYoutubeId(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (!ALLOWED_HOSTS.has(host)) return ''
    const parts = url.pathname.split('/').filter(Boolean)
    const id = host.endsWith('youtu.be') ? parts[0] :
      parts[0] === 'watch' ? url.searchParams.get('v') :
      ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : ''
    return ID_PATTERN.test(String(id || '')) ? id : ''
  } catch {
    return ''
  }
}

async function googleProbe(ids, key) {
  const query = new URLSearchParams({ part: 'status', id: ids.join(','), key })
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) throw new Error(`YOUTUBE_DATA_API_${response.status}`)
  const data = await response.json()
  if (!Array.isArray(data?.items)) throw new Error('YOUTUBE_DATA_API_INVALID_RESPONSE')
  const rows = new Map(data.items.map(item => [String(item?.id || ''), item]))
  return new Map(ids.map(id => {
    const video = rows.get(id)
    if (!video) return [id, 'missing']
    const status = video.status
    if (!status) return [id, 'unknown']
    if (status.privacyStatus === 'private' ||
        ['deleted', 'failed', 'rejected'].includes(status.uploadStatus) ||
        status.embeddable === false) return [id, 'missing']
    if (['public', 'unlisted'].includes(status.privacyStatus)) return [id, 'live']
    return [id, 'unknown']
  }))
}

async function oembedProbe(id) {
  try {
    const url = new URL('https://www.youtube.com/oembed')
    url.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`)
    url.searchParams.set('format', 'json')
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) return 'live'
    if ([404, 410].includes(response.status)) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function oembedBatch(ids) {
  const results = new Map()
  let position = 0
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (position < ids.length) {
      const id = ids[position++]
      results.set(id, await oembedProbe(id))
    }
  }))
  return results
}

export async function probeStudioYoutubeIds(ids) {
  const valid = [...new Set((Array.isArray(ids) ? ids : []).filter(id => ID_PATTERN.test(String(id))))]
  if (!valid.length) return new Map()
  if (valid.length > 50) throw new RangeError('Too many YouTube IDs in one batch')
  const key = process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || ''
  if (key) {
    try {
      return await googleProbe(valid, key)
    } catch (error) {
      console.warn('STUDIO_YOUTUBE_HEALTH_GOOGLE_UNAVAILABLE', error?.message || 'unknown')
      return new Map(valid.map(id => [id, 'unknown']))
    }
  }
  return oembedBatch(valid)
}
