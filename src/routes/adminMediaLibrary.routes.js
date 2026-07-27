import express from 'express'
import multer from 'multer'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createMediaFolder,
  createMediaItem,
  deleteMediaFolder,
  deleteMediaItem,
  getAdminMediaLibrary,
  removeMediaFolderCover,
  updateMediaFolder,
  updateMediaItem,
  uploadMediaFolderCover,
} from '../controllers/adminMediaLibrary.controller.js'
import { uploadMediaLibraryObject } from '../services/mediaLibraryR2.service.js'

const router = express.Router()
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 20,
  },
  fileFilter(req, file, callback) {
    if (allowedTypes.has(file.mimetype)) return callback(null, true)
    const error = new Error('Only JPEG, PNG, WEBP, GIF or AVIF images are allowed')
    error.statusCode = 400
    return callback(error)
  },
})

function runUpload(handler) {
  return (req, res, next) => {
    handler(req, res, (error) => {
      if (!error) return next()
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be 20 MB or smaller'
        : error.message || 'Invalid image'
      return res.status(error.statusCode || 400).json({ ok: false, message })
    })
  }
}

router.get('/', requireAdmin, getAdminMediaLibrary)

router.post('/upload', requireAdmin, runUpload(upload.array('images', 20)), async (req, res) => {
  const uploaded = []

  try {
    const files = Array.isArray(req.files) ? req.files : []
    if (!files.length) return res.status(400).json({ ok: false, message: 'At least one image is required' })

    for (const file of files) {
      const result = await uploadMediaLibraryObject({
        file,
        prefix: 'media-library/images',
      })
      uploaded.push({
        original_name: file.originalname,
        storage_key: result.storage_key,
        image_url: result.image_url,
      })
    }

    return res.status(201).json({ ok: true, images: uploaded })
  } catch (error) {
    console.error('UPLOAD MEDIA LIBRARY ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to upload images' })
  }
})

router.post('/folders', requireAdmin, createMediaFolder)
router.patch('/folders/:folderId', requireAdmin, updateMediaFolder)
router.post('/folders/:folderId/cover', requireAdmin, runUpload(upload.single('cover')), uploadMediaFolderCover)
router.delete('/folders/:folderId/cover', requireAdmin, removeMediaFolderCover)
router.delete('/folders/:folderId', requireAdmin, deleteMediaFolder)

router.post('/images', requireAdmin, createMediaItem)
router.patch('/images/:imageId', requireAdmin, updateMediaItem)
router.delete('/images/:imageId', requireAdmin, deleteMediaItem)

export default router
