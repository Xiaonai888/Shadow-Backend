import { supabase } from '../config/supabase.js'
import { filterVisibleSavedReaderPosts } from '../services/readerPostPrivacy.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REACTION_TYPES = new Set(['love', 'haha', 'wow', 'sad', 'angry', 'support', 'touched'])

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

async function getRows(table, fields, ids, field = 'id', filter = query => query) {
  if (!ids.length) return []
  const { data, error } = await filter(supabase.from(table).select(fields).in(field, ids))
  if (error) throw error
  return data || []
}

function firstImage(images) {
  return Array.isArray(images) ? images.find(url => typeof url === 'string' && url.trim()) || '' : ''
}

function youtubeId(value) {
  const source = String(value || '').trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(source)) return source
  try {
    const url = new URL(source)
    if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) return url.pathname.split('/')[1] || ''
    if (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) {
      return url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] || ''
    }
  } catch {
    return ''
  }
  return ''
}

function summaryFromSql(row) {
  return Array.isArray(row?.reaction_summary)
    ? row.reaction_summary.filter(entry => REACTION_TYPES.has(entry?.type) && Number(entry.count) > 0).slice(0, 3)
    : []
}

export async function getSavedPostCards(req, res) {
  try {
    const userId = String(req.user?.user_id || req.user?.id || '').trim()
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const raw = String(req.query.ids || '').split(',').map(value => value.trim()).filter(Boolean)
    const ids = unique(raw)
    if (!ids.length || ids.length > 30 || ids.some(id => !UUID.test(id))) {
      return res.status(400).json({ ok: false, message: 'Provide 1 to 30 valid saved post IDs' })
    }

    const { data: saved, error: savedError } = await supabase
      .from('saved_posts')
      .select('id,source_type,source_id,status')
      .eq('user_id', userId)
      .in('id', ids)
    if (savedError) throw savedError
    const owned = (saved || []).filter(row => row.status !== 'unavailable')
    const visible = await filterVisibleSavedReaderPosts(owned, userId)
    const grouped = Object.fromEntries(['reader_post', 'author_post', 'fast_video', 'promotion'].map(key => [key, []]))
    for (const row of visible) {
      if (!grouped[row.source_type]) continue
      const id = String(row.source_id || '')
      if (row.source_type === 'promotion' ? /^[1-9]\d*$/.test(id) : UUID.test(id)) {
        grouped[row.source_type].push(id)
      }
    }
    for (const key of Object.keys(grouped)) grouped[key] = unique(grouped[key])

    const [readers, authors, reels, promotions] = await Promise.all([
      getRows('reader_posts', 'id,user_id,content,image_urls,like_count,deleted_at', grouped.reader_post, 'id', query => query.is('deleted_at', null)),
      getRows('author_page_posts', 'id,user_id,author_page_id,content,image_urls,like_count', grouped.author_post, 'id', query => query.eq('status', 'active')),
      getRows('fast_videos', 'id,user_id,title,description,thumbnail_url,video_url', grouped.fast_video, 'id', query => query.eq('status', 'published').eq('access_type', 'free').eq('platform', 'youtube')),
      getRows('shadow_mall_ads', 'id,sponsor,title,description,profile_image_url,image_url,like_count', grouped.promotion, 'id', query => query.eq('is_active', true)),
    ])

    const ownerIds = unique([...readers.map(row => row.user_id), ...reels.map(row => row.user_id)])
    const authorPageIds = unique(authors.map(row => row.author_page_id))
    const reelOwnerIds = unique(reels.map(row => row.user_id))
    const [users, authorPages, reelPages, reactionResult] = await Promise.all([
      getRows('users', 'id,name,username,avatar_url', ownerIds),
      getRows('author_pages', 'id,user_id,page_name,page_username,avatar_url', authorPageIds, 'id', query => query.eq('status', 'active')),
      getRows('author_pages', 'id,user_id,page_name,page_username,avatar_url', reelOwnerIds, 'user_id', query => query.eq('status', 'active')),
      supabase.rpc('shadow_saved_post_card_reactions', {
        p_reader_ids: grouped.reader_post,
        p_author_ids: grouped.author_post,
        p_reel_ids: grouped.fast_video,
        p_promotion_ids: grouped.promotion.map(Number),
      }),
    ])

    if (reactionResult.error && !['PGRST202', '42883'].includes(reactionResult.error.code)) throw reactionResult.error
    const userMap = new Map(users.map(row => [String(row.id), row]))
    const authorPageMap = new Map(authorPages.map(row => [String(row.id), row]))
    const reelPageMap = new Map(reelPages.map(row => [String(row.user_id), row]))
    const readerMap = new Map(readers.map(row => [String(row.id), row]))
    const authorMap = new Map(authors.map(row => [String(row.id), row]))
    const reelMap = new Map(reels.map(row => [String(row.id), row]))
    const promotionMap = new Map(promotions.map(row => [String(row.id), row]))
    const reactionMap = new Map((reactionResult.data || []).map(row => [`${row.source_type}:${row.source_id}`, row]))
    const cards = {}

    for (const savedRow of visible) {
      const sourceId = String(savedRow.source_id || '')
      const sourceType = String(savedRow.source_type || '')
      const summary = reactionMap.get(`${sourceType}:${sourceId}`)
      let entry = null

      if (sourceType === 'reader_post') {
        const post = readerMap.get(sourceId)
        if (!post) continue
        const user = userMap.get(String(post.user_id))
        entry = {
          name: user?.name || user?.username || '',
          avatar_url: user?.avatar_url || '',
          content: post.content || '',
          image_url: firstImage(post.image_urls),
          like_count: Number(summary?.like_count ?? post.like_count ?? 0),
          reaction_summary: summaryFromSql(summary),
          reaction_kind: 'reactions',
        }
      } else if (sourceType === 'author_post') {
        const post = authorMap.get(sourceId)
        if (!post) continue
        const page = authorPageMap.get(String(post.author_page_id))
        if (!page) continue
        entry = {
          name: page.page_name || page.page_username || '',
          avatar_url: page.avatar_url || '',
          content: post.content || '',
          image_url: firstImage(post.image_urls),
          like_count: Number(summary?.like_count ?? post.like_count ?? 0),
          reaction_summary: summaryFromSql(summary),
          reaction_kind: 'reactions',
        }
      } else if (sourceType === 'fast_video') {
        const video = reelMap.get(sourceId)
        if (!video) continue
        const page = reelPageMap.get(String(video.user_id))
        const user = userMap.get(String(video.user_id))
        const youtube = youtubeId(video.video_url)
        entry = {
          name: page?.page_name || page?.page_username || user?.name || user?.username || '',
          avatar_url: page?.avatar_url || user?.avatar_url || '',
          title: video.title || '',
          content: video.description || '',
          image_url: video.thumbnail_url || (youtube ? `https://img.youtube.com/vi/${youtube}/hqdefault.jpg` : ''),
          like_count: reactionResult.error ? null : Number(summary?.like_count || 0),
          reaction_summary: [],
          reaction_kind: 'likes',
        }
      } else if (sourceType === 'promotion') {
        const promotion = promotionMap.get(sourceId)
        if (!promotion) continue
        entry = {
          name: promotion.sponsor || '',
          avatar_url: promotion.profile_image_url || '',
          title: promotion.title || '',
          content: promotion.description || '',
          image_url: promotion.image_url || '',
          like_count: Number(summary?.like_count ?? promotion.like_count ?? 0),
          reaction_summary: summaryFromSql(summary),
          reaction_kind: 'reactions',
        }
      }

      if (entry) cards[String(savedRow.id)] = entry
    }

    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, cards })
  } catch (error) {
    console.error('GET SAVED POST CARD DATA ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load saved post card data' })
  }
}
