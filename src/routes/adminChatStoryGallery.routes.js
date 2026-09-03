import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createAdminChatStoryGalleryImage,
  deleteAdminChatStoryGalleryImage,
  getAdminChatStoryGallery,
  updateAdminChatStoryGalleryImage,
} from '../controllers/adminChatStoryGallery.controller.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 20,
  },
})

function envValue(key) {
  return String(process.env[key] || '').trim()
}

const r2AccountId = envValue('R2_ACCOUNT_ID')
const r2Endpoint =
  envValue('CLOUDFLARE_R2_ENDPOINT') ||
  (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : '')

const r2AccessKeyId =
  envValue('CLOUDFLARE_R2_ACCESS_KEY_ID') ||
  envValue('R2_ACCESS_KEY_ID')

const r2SecretAccessKey =
  envValue('CLOUDFLARE_R2_SECRET_ACCESS_KEY') ||
  envValue('R2_SECRET_ACCESS_KEY')

const r2Bucket =
  envValue('CLOUDFLARE_R2_BUCKET') ||
  envValue('R2_BUCKET_NAME')

const r2PublicUrl =
  envValue('CLOUDFLARE_R2_PUBLIC_URL') ||
  envValue('R2_PUBLIC_URL')

const r2 = new S3Client({
  region: 'auto',
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: r2AccessKeyId,
    secretAccessKey: r2SecretAccessKey,
  },
})

function safeExtension(file) {
  const originalName = file.originalname || ''
  const fromName = originalName.includes('.') ? originalName.split('.').pop() : ''
  const fromMime = file.mimetype?.split('/')[1] || 'jpg'
  return (fromName || fromMime).toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
}

function tempFiles(req) {
  return (Array.isArray(req.files) ? req.files : [])
    .map((file) => file?.path)
    .filter(Boolean)
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

function uploadGalleryImages(req, res, next) {
  upload.array('images', 20)(req, res, (error) => {
    if (!error) return next()

    removeTempFiles(req).catch(() => {})

    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be 5 MB or smaller'
        : error.message || 'Invalid image upload'

    return res.status(status).json({
      ok: false,
      message,
    })
  })
}

router.get('/', requireAdmin, getAdminChatStoryGallery)

router.post(
  '/upload',
  requireAdmin,
  uploadGalleryImages,
  cleanupTempFiles,
  async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files : []

      if (!files.length) {
        return res.status(400).json({
          ok: false,
          message: 'At least one image is required',
        })
      }

      const invalidFile = files.find((file) => !file.mimetype?.startsWith('image/'))

      if (invalidFile) {
        return res.status(400).json({
          ok: false,
          message: 'Only image files are allowed',
        })
      }

      if (!r2Bucket || !r2PublicUrl || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
        return res.status(500).json({
          ok: false,
          message: 'Cloudflare R2 is not configured',
        })
      }

      const uploaded = []

      for (const file of files) {
        const ext = safeExtension(file)
        const key = `chat-story-gallery/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

        await r2.send(
          new PutObjectCommand({
            Bucket: r2Bucket,
            Key: key,
            Body: createReadStream(file.path),
            ContentLength: Number(file.size || 0) || undefined,
            ContentType: file.mimetype,
          })
        )

        uploaded.push({
          original_name: file.originalname,
          image_url: `${r2PublicUrl.replace(/\/$/, '')}/${key}`,
        })
      }

      return res.status(201).json({
        ok: true,
        images: uploaded,
      })
    } catch (error) {
      console.error('UPLOAD ADMIN CHAT STORY GALLERY ERROR:', error)
      return res.status(500).json({
        ok: false,
        message: error.message || 'Failed to upload gallery images',
      })
    }
  }
)

router.post('/', requireAdmin, createAdminChatStoryGalleryImage)
router.patch('/:imageId', requireAdmin, updateAdminChatStoryGalleryImage)
router.delete('/:imageId', requireAdmin, deleteAdminChatStoryGalleryImage)

export default router
