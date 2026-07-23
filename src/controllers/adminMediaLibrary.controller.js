import { supabase } from '../config/supabase.js'

function text(value, max = 200) {
  return String(value || '').trim().slice(0, max)
}

function bool(value, fallback = true) {
  if (value === undefined) return fallback
  return value !== false && value !== 'false'
}

function order(value) {
  return Math.max(0, Math.floor(Number(value) || 0))
}

export async function getAdminMediaLibrary(req, res) {
  try {
    const [{ data: folders, error: foldersError }, { data: images, error: imagesError }] =
      await Promise.all([
        supabase
          .from('media_folders')
          .select('id, name, icon, description, sort_order, is_active, created_at, updated_at')
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase
          .from('media_library')
          .select('id, folder_id, title, alt_text, image_url, storage_key, media_type, tags, sort_order, is_active, created_at, updated_at')
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: false }),
      ])

    if (foldersError) throw foldersError
    if (imagesError) throw imagesError

    return res.status(200).json({
      ok: true,
      folders: folders || [],
      images: images || [],
    })
  } catch (error) {
    console.error('GET ADMIN MEDIA LIBRARY ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to load media library' })
  }
}

export async function createMediaFolder(req, res) {
  try {
    const name = text(req.body.name, 100)
    if (!name) return res.status(400).json({ ok: false, message: 'Folder name is required' })

    const { data, error } = await supabase
      .from('media_folders')
      .insert({
        name,
        icon: text(req.body.icon, 20) || '📁',
        description: text(req.body.description, 300),
        sort_order: order(req.body.sort_order),
        is_active: bool(req.body.is_active),
        updated_at: new Date().toISOString(),
      })
      .select('id, name, icon, description, sort_order, is_active, created_at, updated_at')
      .single()

    if (error) throw error
    return res.status(201).json({ ok: true, folder: data })
  } catch (error) {
    console.error('CREATE MEDIA FOLDER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to create folder' })
  }
}

export async function updateMediaFolder(req, res) {
  try {
    const patch = { updated_at: new Date().toISOString() }

    if ('name' in req.body) patch.name = text(req.body.name, 100)
    if ('icon' in req.body) patch.icon = text(req.body.icon, 20) || '📁'
    if ('description' in req.body) patch.description = text(req.body.description, 300)
    if ('sort_order' in req.body) patch.sort_order = order(req.body.sort_order)
    if ('is_active' in req.body) patch.is_active = bool(req.body.is_active)

    const { data, error } = await supabase
      .from('media_folders')
      .update(patch)
      .eq('id', req.params.folderId)
      .select('id, name, icon, description, sort_order, is_active, created_at, updated_at')
      .single()

    if (error) throw error
    return res.status(200).json({ ok: true, folder: data })
  } catch (error) {
    console.error('UPDATE MEDIA FOLDER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update folder' })
  }
}

export async function deleteMediaFolder(req, res) {
  try {
    const { error } = await supabase.from('media_folders').delete().eq('id', req.params.folderId)
    if (error) throw error
    return res.status(200).json({ ok: true, message: 'Folder deleted' })
  } catch (error) {
    console.error('DELETE MEDIA FOLDER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to delete folder' })
  }
}

export async function createMediaItem(req, res) {
  try {
    const folderId = text(req.body.folder_id, 100)
    const title = text(req.body.title, 120)
    const imageUrl = text(req.body.image_url, 1000)

    if (!folderId || !title || !imageUrl) {
      return res.status(400).json({ ok: false, message: 'Folder, title and image URL are required' })
    }

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map((item) => text(item, 40)).filter(Boolean).slice(0, 20)
      : []

    const { data, error } = await supabase
      .from('media_library')
      .insert({
        folder_id: folderId,
        title,
        alt_text: text(req.body.alt_text || title, 180),
        image_url: imageUrl,
        storage_key: text(req.body.storage_key, 500) || null,
        media_type: text(req.body.media_type, 30) || 'image',
        tags,
        sort_order: order(req.body.sort_order),
        is_active: bool(req.body.is_active),
        updated_at: new Date().toISOString(),
      })
      .select('id, folder_id, title, alt_text, image_url, storage_key, media_type, tags, sort_order, is_active, created_at, updated_at')
      .single()

    if (error) throw error
    return res.status(201).json({ ok: true, image: data })
  } catch (error) {
    console.error('CREATE MEDIA ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to create media item' })
  }
}

export async function updateMediaItem(req, res) {
  try {
    const patch = { updated_at: new Date().toISOString() }

    if ('folder_id' in req.body) patch.folder_id = text(req.body.folder_id, 100)
    if ('title' in req.body) patch.title = text(req.body.title, 120)
    if ('alt_text' in req.body) patch.alt_text = text(req.body.alt_text, 180)
    if ('tags' in req.body) {
      patch.tags = Array.isArray(req.body.tags)
        ? req.body.tags.map((item) => text(item, 40)).filter(Boolean).slice(0, 20)
        : []
    }
    if ('sort_order' in req.body) patch.sort_order = order(req.body.sort_order)
    if ('is_active' in req.body) patch.is_active = bool(req.body.is_active)

    const { data, error } = await supabase
      .from('media_library')
      .update(patch)
      .eq('id', req.params.imageId)
      .select('id, folder_id, title, alt_text, image_url, storage_key, media_type, tags, sort_order, is_active, created_at, updated_at')
      .single()

    if (error) throw error
    return res.status(200).json({ ok: true, image: data })
  } catch (error) {
    console.error('UPDATE MEDIA ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update media item' })
  }
}

export async function deleteMediaItem(req, res) {
  try {
    const { error } = await supabase.from('media_library').delete().eq('id', req.params.imageId)
    if (error) throw error
    return res.status(200).json({ ok: true, message: 'Media item deleted' })
  } catch (error) {
    console.error('DELETE MEDIA ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to delete media item' })
  }
}
