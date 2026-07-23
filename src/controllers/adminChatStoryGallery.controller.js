import { supabase } from '../config/supabase.js'

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max)
}

function cleanCategory(value) {
  const allowed = ['Female', 'Male', 'Couple', 'Fantasy', 'Other']
  const category = cleanText(value, 40)
  return allowed.includes(category) ? category : 'Other'
}

export async function getAdminChatStoryGallery(req, res) {
  try {
    const { data, error } = await supabase
      .from('chat_story_avatar_gallery')
      .select('id, title, alt_text, image_url, category, is_active, sort_order, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      images: data || [],
    })
  } catch (error) {
    console.error('GET ADMIN CHAT STORY GALLERY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load gallery images',
    })
  }
}

export async function createAdminChatStoryGalleryImage(req, res) {
  try {
    const title = cleanText(req.body.title, 120)
    const altText = cleanText(req.body.alt_text || title, 180)
    const imageUrl = cleanText(req.body.image_url, 1000)
    const category = cleanCategory(req.body.category)
    const sortOrder = Number.isFinite(Number(req.body.sort_order))
      ? Math.max(0, Math.floor(Number(req.body.sort_order)))
      : 0
    const isActive = req.body.is_active !== false && req.body.is_active !== 'false'

    if (!title || !imageUrl) {
      return res.status(400).json({
        ok: false,
        message: 'Title and image URL are required',
      })
    }

    const { data, error } = await supabase
      .from('chat_story_avatar_gallery')
      .insert({
        title,
        alt_text: altText,
        image_url: imageUrl,
        category,
        is_active: isActive,
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
      })
      .select('id, title, alt_text, image_url, category, is_active, sort_order, created_at, updated_at')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      image: data,
    })
  } catch (error) {
    console.error('CREATE ADMIN CHAT STORY GALLERY IMAGE ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to create gallery image',
    })
  }
}

export async function updateAdminChatStoryGalleryImage(req, res) {
  try {
    const imageId = cleanText(req.params.imageId, 100)
    const patch = {
      updated_at: new Date().toISOString(),
    }

    if ('title' in req.body) patch.title = cleanText(req.body.title, 120)
    if ('alt_text' in req.body) patch.alt_text = cleanText(req.body.alt_text, 180)
    if ('category' in req.body) patch.category = cleanCategory(req.body.category)
    if ('is_active' in req.body) {
      patch.is_active = req.body.is_active !== false && req.body.is_active !== 'false'
    }
    if ('sort_order' in req.body) {
      patch.sort_order = Math.max(0, Math.floor(Number(req.body.sort_order) || 0))
    }

    const { data, error } = await supabase
      .from('chat_story_avatar_gallery')
      .update(patch)
      .eq('id', imageId)
      .select('id, title, alt_text, image_url, category, is_active, sort_order, created_at, updated_at')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      image: data,
    })
  } catch (error) {
    console.error('UPDATE ADMIN CHAT STORY GALLERY IMAGE ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to update gallery image',
    })
  }
}

export async function deleteAdminChatStoryGalleryImage(req, res) {
  try {
    const imageId = cleanText(req.params.imageId, 100)

    const { error } = await supabase
      .from('chat_story_avatar_gallery')
      .delete()
      .eq('id', imageId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Gallery image deleted',
    })
  } catch (error) {
    console.error('DELETE ADMIN CHAT STORY GALLERY IMAGE ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to delete gallery image',
    })
  }
}
