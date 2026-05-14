import { supabase } from '../config/supabase.js'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media'

const ALLOWED_FOLDERS = {
  story_cover: 'story-covers',
  story_slide: 'story-slides',
  episode_cover: 'episode-covers',
  episode_content: 'episode-content',
}

function safeFileExt(filename = '') {
  const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg'
  return ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
}

function safeFolder(folderKey = '') {
  return ALLOWED_FOLDERS[folderKey] || 'story-uploads'
}

function makeStoragePath({ folder, userId, file }) {
  const ext = safeFileExt(file?.originalname || 'image.jpg')
  const random = Math.random().toString(36).slice(2)
  const timestamp = Date.now()

  return `${folder}/${userId}/${timestamp}-${random}.${ext}`
}

function getPublicUrl(storagePath) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

export async function uploadStoryImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'Image file is required. Use form field name: image',
      })
    }

    if (!req.file.mimetype?.startsWith('image/')) {
      return res.status(400).json({
        ok: false,
        message: 'Only image files are allowed',
      })
    }

    const folder = safeFolder(req.body.folder || req.query.folder)
    const storagePath = makeStoragePath({
      folder,
      userId,
      file: req.file,
    })

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      })

    if (error) throw error

    const imageUrl = getPublicUrl(storagePath)

    return res.status(201).json({
      ok: true,
      message: 'Image uploaded successfully',
      bucket: BUCKET,
      path: storagePath,
      image_url: imageUrl,
      imageUrl,
    })
  } catch (error) {
    console.error('UPLOAD STORY IMAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to upload image',
      error: error.message,
    })
  }
}
