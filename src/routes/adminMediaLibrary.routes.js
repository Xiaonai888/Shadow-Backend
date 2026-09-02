import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
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
  dest: os.tmpdir(),
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

function tempFiles(req) {
  const files = []

  if (req.file?.path) {
    files.push(req.file.path)
  }

  if (Array.isArray(req.files)) {
    for (const file of req.files) {
      if (file?.path) files.push(file.path)
    }
  } else if (req.files && typeof req.files === 'object') {
    for (const values of Object.values(req.files)) {
      for (const file of Array.isArray(values) ? values : []) {
        if (file?.path) files.push(file.path)
      }
    }
  }

  return [...new Set(files)]
}

async function removeTempFiles(req) {
  await Promise.all(
    tempFiles(req).map((filePath) =>
      unlink(filePath).catch(() => {})
    )
  )
}

function cleanupTempFiles(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFiles(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function runUpload(handler) {
  return (req, res, next) => {
    handler(req, res, (error) => {
      if (!error) return next()

      removeTempFiles(req).catch(() => {})

      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be 20 MB or smaller'
        : error.message || 'Invalid image'

      return res.status(error.statusCode || 400).json({
        ok: false,
        message,
      })
    })
  }
}

const viewMediaLibrary = requireAdminPermission('media_library.view')
const manageMediaLibrary = requireAdminPermission('media_library.manage')

router.get('/', viewMediaLibrary, getAdminMediaLibrary)

router.post(
  '/upload',
  manageMediaLibrary,
  runUpload(upload.array('images', 20)),
  cleanupTempFiles,
  async (req, res) => {
    const uploaded = []

    try {
      const files = Array.isArray(req.files) ? req.files : []

      if (!files.length) {
        return res.status(400).json({
          ok: false,
          message: 'At least one image is required',
        })
      }

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

      return res.status(201).json({
        ok: true,
        images: uploaded,
      })
    } catch (error) {
      console.error('UPLOAD MEDIA LIBRARY ERROR:', error)
      return res.status(error.statusCode || 500).json({
        ok: false,
        message: error.message || 'Failed to upload images',
      })
    }
  }
)

router.post('/folders', manageMediaLibrary, createMediaFolder)
router.patch('/folders/:folderId', manageMediaLibrary, updateMediaFolder)

router.post(
  '/folders/:folderId/cover',
  manageMediaLibrary,
  runUpload(upload.single('cover')),
  cleanupTempFiles,
  uploadMediaFolderCover
)

router.delete('/folders/:folderId/cover', manageMediaLibrary, removeMediaFolderCover)
router.delete('/folders/:folderId', manageMediaLibrary, deleteMediaFolder)

router.post('/images', manageMediaLibrary, createMediaItem)
router.patch('/images/:imageId', manageMediaLibrary, updateMediaItem)
router.delete('/images/:imageId', manageMediaLibrary, deleteMediaItem)

export default router
