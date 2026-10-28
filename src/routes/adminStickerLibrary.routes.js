import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { guardDiskBackedUploads } from '../middleware/globalMediaUploadGuard.middleware.js'
import {
  listStickers,
  createStickerFolder,
  updateStickerFolder,
  uploadStickerCover,
  deleteStickerCover,
  deleteStickerFolder,
  createStickerImage,
  updateStickerImage,
  deleteStickerImage,
} from '../controllers/adminStickerLibrary.controller.js'

const router = express.Router()

// Reuse the existing Admin Media Library permissions and disk-backed upload guard.
const canView = requireAdminPermission('media_library.view')
const canManage = requireAdminPermission('media_library.manage')
const coverTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

const coverUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    if (coverTypes.has(file.mimetype)) return callback(null, true)
    const error = new Error('Folder cover must be JPEG, PNG, WEBP, GIF or AVIF')
    error.statusCode = 400
    return callback(error)
  },
})

async function removeTemporaryCover(req) {
  // Multer generates a random 32-character hex filename in os.tmpdir().
  // Never delete a path taken directly from the request object.
  const filename = req.file?.filename
  if (typeof filename !== 'string') return
  const safeFilename = basename(filename)
  if (safeFilename !== filename || !/^[0-9a-f]{32}$/.test(safeFilename)) return
  await unlink(join(os.tmpdir(), safeFilename)).catch(() => {})
}

function acceptCover(req, res, next) {
  coverUpload.single('cover')(req, res, (error) => {
    if (error) {
      void removeTemporaryCover(req)
      return res.status(error.statusCode || 400).json({
        ok: false,
        code: error.code || 'STICKER_COVER_INVALID',
        message: error.code === 'LIMIT_FILE_SIZE'
          ? 'Folder cover must be 5 MB or smaller'
          : error.message || 'Invalid folder cover',
      })
    }
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        code: 'STICKER_COVER_REQUIRED',
        message: 'Choose a folder cover image',
      })
    }
    res.once('finish', () => { void removeTemporaryCover(req) })
    res.once('close', () => { void removeTemporaryCover(req) })
    next()
  })
}

// Image uploads deliberately stay in the existing Cloudflare upload pipeline.
// This router saves sticker records and their animation settings only.
router.get('/', canView, listStickers)
router.post('/folders', canManage, createStickerFolder)
router.patch('/folders/:folderId', canManage, updateStickerFolder)
router.post(
  '/folders/:folderId/cover',
  canManage,
  acceptCover,
  guardDiskBackedUploads,
  uploadStickerCover,
)
router.delete('/folders/:folderId/cover', canManage, deleteStickerCover)
router.delete('/folders/:folderId', canManage, deleteStickerFolder)
router.post('/images', canManage, createStickerImage)
router.patch('/images/:imageId', canManage, updateStickerImage)
router.delete('/images/:imageId', canManage, deleteStickerImage)

export default router
