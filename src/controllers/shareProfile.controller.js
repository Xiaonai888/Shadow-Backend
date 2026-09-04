import {
  deleteR2ObjectByKey,
  uploadImageToR2AsWebP,
} from '../services/r2Storage.service.js'

const CUSTOM_IMAGE_TTL_MS = 24 * 60 * 60 * 1000

function getSafeUserId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '')
}

function getCustomImageKey(userId) {
  return `share-profile-temp/${getSafeUserId(userId)}.webp`
}

export async function uploadShareProfileCustomImage(req, res) {
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

    const key = getCustomImageKey(userId)
    const expiresAt = new Date(Date.now() + CUSTOM_IMAGE_TTL_MS).toISOString()
    const baseImageUrl = await uploadImageToR2AsWebP(
      req.file,
      'share-profile-temp',
      {
        width: 1080,
        height: 1920,
        fit: 'cover',
        quality: 82,
        withoutEnlargement: false,
        objectKey: key,
        cacheControl: 'public, max-age=300, must-revalidate',
        contentDisposition: 'inline',
        metadata: {
          expiresat: expiresAt,
          userid: String(userId),
        },
      }
    )
    const imageUrl = `${baseImageUrl}?v=${Date.now()}`

    return res.status(201).json({
      ok: true,
      image_url: imageUrl,
      imageUrl,
      expires_at: expiresAt,
      expiresAt,
      lifetime_hours: 24,
    })
  } catch (error) {
    console.error('UPLOAD SHARE PROFILE IMAGE ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to upload custom background',
    })
  }
}

export async function deleteShareProfileCustomImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    await deleteR2ObjectByKey(
      getCustomImageKey(userId)
    )

    return res.status(200).json({
      ok: true,
      message: 'Custom background deleted',
    })
  } catch (error) {
    console.error('DELETE SHARE PROFILE IMAGE ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to delete custom background',
    })
  }
}
