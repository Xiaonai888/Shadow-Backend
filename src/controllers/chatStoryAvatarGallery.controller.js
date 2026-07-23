import { supabase } from '../config/supabase.js'

export async function getChatStoryAvatarGallery(req, res) {
  try {
    const category = String(req.query.category || '').trim()
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200)

    let query = supabase
      .from('chat_story_avatar_gallery')
      .select('id, title, alt_text, image_url, category, sort_order')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(limit)

    if (category && category.toLowerCase() !== 'all') {
      query = query.eq('category', category)
    }

    const { data, error } = await query

    if (error) throw error

    const images = data || []
    const categories = [...new Set(images.map((item) => item.category).filter(Boolean))]

    return res.status(200).json({
      ok: true,
      categories,
      images,
    })
  } catch (error) {
    console.error('GET CHAT STORY AVATAR GALLERY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow gallery',
      error: error.message,
    })
  }
}
