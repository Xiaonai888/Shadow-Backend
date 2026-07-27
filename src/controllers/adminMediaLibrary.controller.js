import { supabase } from '../config/supabase.js'
import {
  deleteMediaLibraryObject,
  deleteMediaLibraryObjects,
  mediaLibraryFolderPrefix,
  uploadMediaLibraryObject,
} from '../services/mediaLibraryR2.service.js'

const FOLDER_FIELDS = 'id, name, icon, description, cover_image_url, cover_storage_key, sort_order, is_active, created_at, updated_at'
const IMAGE_FIELDS = 'id, folder_id, title, alt_text, image_url, storage_key, media_type, tags, sort_order, is_active, created_at, updated_at'

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

async function findFolder(folderId) {
  const { data, error } = await supabase
    .from('media_folders')
    .select(FOLDER_FIELDS)
    .eq('id', folderId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function findImage(imageId) {
  const { data, error } = await supabase
    .from('media_library')
    .select(IMAGE_FIELDS)
    .eq('id', imageId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getAdminMediaLibrary(req, res) {
  try {
    const [{ data: folders, error: foldersError }, { data: images, error: imagesError }] = await Promise.all([
      supabase
        .from('media_folders')
        .select(FOLDER_FIELDS)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('media_library')
        .select(IMAGE_FIELDS)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false }),
    ])

    if (foldersError) throw foldersError
    if (imagesError) throw imagesError

    return res.status(200).json({ ok: true, folders: folders || [], images: images || [] })
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
        cover_image_url: null,
        cover_storage_key: null,
        sort_order: order(req.body.sort_order),
        is_active: bool(req.body.is_active),
        updated_at: new Date().toISOString(),
      })
      .select(FOLDER_FIELDS)
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
      .select(FOLDER_FIELDS)
      .single()

    if (error) throw error
    return res.status(200).json({ ok: true, folder: data })
  } catch (error) {
    console.error('UPDATE MEDIA FOLDER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update folder' })
  }
}

export async function uploadMediaFolderCover(req, res) {
  let uploaded = null

  try {
    if (!req.file) return res.status(400).json({ ok: false, message: 'Folder cover is required' })

    const existing = await findFolder(req.params.folderId)
    if (!existing) return res.status(404).json({ ok: false, message: 'Folder not found' })

    uploaded = await uploadMediaLibraryObject({
      file: req.file,
      prefix: mediaLibraryFolderPrefix(existing.id),
    })

    const { data, error } = await supabase
      .from('media_folders')
      .update({
        cover_image_url: uploaded.image_url,
        cover_storage_key: uploaded.storage_key,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select(FOLDER_FIELDS)
      .single()

    if (error) throw error

    let cleanupWarning = null
    if (existing.cover_storage_key && existing.cover_storage_key !== uploaded.storage_key) {
      try {
        await deleteMediaLibraryObject(existing.cover_storage_key)
      } catch (cleanupError) {
        cleanupWarning = cleanupError.message
      }
    }

    return res.status(200).json({ ok: true, folder: data, cleanup_warning: cleanupWarning })
  } catch (error) {
    if (uploaded?.storage_key) await deleteMediaLibraryObject(uploaded.storage_key).catch(() => {})
    console.error('UPLOAD MEDIA FOLDER COVER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to upload folder cover' })
  }
}

export async function removeMediaFolderCover(req, res) {
  try {
    const existing = await findFolder(req.params.folderId)
    if (!existing) return res.status(404).json({ ok: false, message: 'Folder not found' })

    const { data, error } = await supabase
      .from('media_folders')
      .update({
        cover_image_url: null,
        cover_storage_key: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select(FOLDER_FIELDS)
      .single()

    if (error) throw error

    let cleanupWarning = null
    if (existing.cover_storage_key) {
      try {
        await deleteMediaLibraryObject(existing.cover_storage_key)
      } catch (cleanupError) {
        cleanupWarning = cleanupError.message
      }
    }

    return res.status(200).json({ ok: true, folder: data, cleanup_warning: cleanupWarning })
  } catch (error) {
    console.error('REMOVE MEDIA FOLDER COVER ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to remove folder cover' })
  }
}

export async function deleteMediaFolder(req, res) {
  try {
    const existing = await findFolder(req.params.folderId)
    if (!existing) return res.status(404).json({ ok: false, message: 'Folder not found' })

    const { data: images, error: imagesError } = await supabase
      .from('media_library')
      .select('id, storage_key')
      .eq('folder_id', existing.id)
    if (imagesError) throw imagesError

    const { error } = await supabase
      .from('media_folders')
      .delete()
      .eq('id', existing.id)
    if (error) throw error

    const keys = [existing.cover_storage_key, ...(images || []).map((image) => image.storage_key)].filter(Boolean)
    let cleanupWarning = null
    let deletedObjects = 0

    try {
      const cleanup = await deleteMediaLibraryObjects(keys)
      deletedObjects = cleanup.deleted
    } catch (cleanupError) {
      cleanupWarning = cleanupError.message
    }

    return res.status(200).json({
      ok: true,
      message: 'Folder deleted',
      deleted_images: (images || []).length,
      deleted_r2_objects: deletedObjects,
      cleanup_warning: cleanupWarning,
    })
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
      .select(IMAGE_FIELDS)
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
    if ('sort_order' in req.body) patch.sort_order = order(req.body.sort_order)
    if ('is_active' in req.body) patch.is_active = bool(req.body.is_active)
    if ('tags' in req.body) {
      patch.tags = Array.isArray(req.body.tags)
        ? req.body.tags.map((item) => text(item, 40)).filter(Boolean).slice(0, 20)
        : []
    }

    const { data, error } = await supabase
      .from('media_library')
      .update(patch)
      .eq('id', req.params.imageId)
      .select(IMAGE_FIELDS)
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
    const existing = await findImage(req.params.imageId)
    if (!existing) return res.status(404).json({ ok: false, message: 'Media item not found' })

    const { error } = await supabase
      .from('media_library')
      .delete()
      .eq('id', existing.id)
    if (error) throw error

    let cleanupWarning = null
    if (existing.storage_key) {
      try {
        await deleteMediaLibraryObject(existing.storage_key)
      } catch (cleanupError) {
        cleanupWarning = cleanupError.message
      }
    }

    return res.status(200).json({ ok: true, message: 'Media item deleted', cleanup_warning: cleanupWarning })
  } catch (error) {
    console.error('DELETE MEDIA ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to delete media item' })
  }
}
