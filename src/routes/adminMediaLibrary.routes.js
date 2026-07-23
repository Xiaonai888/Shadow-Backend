import express from 'express'
import multer from 'multer'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createMediaFolder,
  createMediaItem,
  deleteMediaFolder,
  deleteMediaItem,
  getAdminMediaLibrary,
  updateMediaFolder,
  updateMediaItem,
} from '../controllers/adminMediaLibrary.controller.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 20,
  },
})

function env(key) {
  return String(process.env[key] || '').trim()
}

const accountId = env('R2_ACCOUNT_ID')
const endpoint =
  env('CLOUDFLARE_R2_ENDPOINT') ||
  (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')
const accessKeyId = env('CLOUDFLARE_R2_ACCESS_KEY_ID') || env('R2_ACCESS_KEY_ID')
const secretAccessKey = env('CLOUDFLARE_R2_SECRET_ACCESS_KEY') || env('R2_SECRET_ACCESS_KEY')
const bucket = env('CLOUDFLARE_R2_BUCKET') || env('R2_BUCKET_NAME')
const publicUrl = env('CLOUDFLARE_R2_PUBLIC_URL') || env('R2_PUBLIC_URL')

const r2 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
})

function extension(file) {
  const name = file.originalname || ''
  const fromName = name.includes('.') ? name.split('.').pop() : ''
  const fromMime = file.mimetype?.split('/')[1] || 'jpg'
  return (fromName || fromMime).toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
}

router.get('/', requireAdmin, getAdminMediaLibrary)

router.post('/upload', requireAdmin, upload.array('images', 20), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : []

    if (!files.length) {
      return res.status(400).json({ ok: false, message: 'At least one image is required' })
    }

    if (files.some((file) => !file.mimetype?.startsWith('image/'))) {
      return res.status(400).json({ ok: false, message: 'Only image files are allowed' })
    }

    if (!bucket || !publicUrl || !endpoint || !accessKeyId || !secretAccessKey) {
      return res.status(500).json({ ok: false, message: 'Cloudflare R2 is not configured' })
    }

    const uploaded = []

    for (const file of files) {
      const key = `media-library/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension(file)}`

      await r2.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }))

      uploaded.push({
        original_name: file.originalname,
        storage_key: key,
        image_url: `${publicUrl.replace(/\/$/, '')}/${key}`,
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
router.delete('/folders/:folderId', requireAdmin, deleteMediaFolder)

router.post('/images', requireAdmin, createMediaItem)
router.patch('/images/:imageId', requireAdmin, updateMediaItem)
router.delete('/images/:imageId', requireAdmin, deleteMediaItem)

export default router
