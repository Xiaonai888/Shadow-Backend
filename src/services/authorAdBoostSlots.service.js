const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PER_KIND = 3
const MAX_TOTAL = 6

function identity(item, kind) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const campaignId = String(item.campaignId || '')
  const contentType = kind === 'post' ? 'post' : String(item.contentType || '')
  const contentId = String(kind === 'post' ? item.postId || item.contentId || '' : item.contentId || '')
  if (!UUID.test(campaignId) || !UUID.test(contentId)) return null
  if (kind === 'book' && contentType !== 'story' && contentType !== 'product') return null
  return { campaignId, contentKey: `${contentType}:${contentId}` }
}

export function selectAuthorAdBoostSlots({ posts = [], books = [], alreadyShown = [] } = {}) {
  if (!Array.isArray(posts) || !Array.isArray(books) || !Array.isArray(alreadyShown)) {
    throw new TypeError('Invalid Boost slot candidates')
  }

  const seenCampaigns = new Set()
  const seenContent = new Set()
  const counts = { post: 0, book: 0 }
  const selected = { posts: [], books: [] }

  for (const item of alreadyShown) {
    const kind = item?.kind
    if (kind !== 'post' && kind !== 'book') continue
    const id = identity(item, kind)
    if (!id || seenCampaigns.has(id.campaignId) || seenContent.has(id.contentKey)) continue
    seenCampaigns.add(id.campaignId)
    seenContent.add(id.contentKey)
    counts[kind] += 1
  }

  for (const [kind, candidates, destination] of [
    ['post', posts, selected.posts],
    ['book', books, selected.books],
  ]) {
    for (const item of candidates) {
      if (seenCampaigns.size >= MAX_TOTAL || counts[kind] >= MAX_PER_KIND) break
      const id = identity(item, kind)
      if (!id || seenCampaigns.has(id.campaignId) || seenContent.has(id.contentKey)) continue
      seenCampaigns.add(id.campaignId)
      seenContent.add(id.contentKey)
      counts[kind] += 1
      destination.push(item)
    }
  }

  return selected
}
