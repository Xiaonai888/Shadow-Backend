import { supabase } from '../config/supabase.js'

export async function getChatStoryAvatarGallery(req, res) {
  try {
    const category = String(req.query.category || '').trim()
    const folderId = String(req.query.folder_id || '').trim()
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200)

    const { data: folderRows, error: foldersError } = await supabase
      .from('media_folders')
      .select(
        'id, name, icon, description, cover_image_url, sort_order, is_active'
      )
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (foldersError) throw foldersError

    let folders = folderRows || []

    if (category && category.toLowerCase() !== 'all') {
      folders = folders.filter(
        (folder) => folder.name.toLowerCase() === category.toLowerCase()
      )
    }

    if (folderId) {
      folders = folders.filter((folder) => folder.id === folderId)
    }

    const activeFolderIds = folders.map((folder) => folder.id)

    if (!activeFolderIds.length) {
      return res.status(200).json({
        ok: true,
        categories: [],
        folders: [],
        images: [],
      })
    }

    const { data: imageRows, error: imagesError } = await supabase
      .from('media_library')
      .select(
        'id, folder_id, title, alt_text, image_url, sort_order, is_active'
      )
      .eq('is_active', true)
      .in('folder_id', activeFolderIds)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(limit)

    if (imagesError) throw imagesError

    const folderMap = new Map(
      folders.map((folder) => [folder.id, folder])
    )

    const images = (imageRows || []).map((image) => {
      const folder = folderMap.get(image.folder_id)

      return {
        id: image.id,
        folder_id: image.folder_id,
        title: image.title,
        alt_text: image.alt_text,
        image_url: image.image_url,
        category: folder?.name || '',
        sort_order: image.sort_order,
      }
    })

    const folderResults = folders.map((folder) => {
      const firstImage = images.find(
        (image) => image.folder_id === folder.id
      )

      return {
        id: folder.id,
        name: folder.name,
        icon: folder.icon || '',
        description: folder.description || '',
        cover_image_url:
          folder.cover_image_url || firstImage?.image_url || '',
        sort_order: folder.sort_order,
      }
    })

    return res.status(200).json({
      ok: true,
      categories: folderResults.map((folder) => folder.name),
      folders: folderResults,
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
