import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  deleteAdminReaderMail,
  getAdminReaderMailHistory,
  getAdminReaderMailLogs,
  searchReadersForMail,
} from '../controllers/adminReaderMails.controller.js'
import {
  sendReaderMailToAll,
  sendReaderMailToOne,
  updateAdminReaderMail,
} from '../controllers/adminReaderMailMediaGuard.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 300 * 1024,
    files: 1,
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

function getSafeFileExt(file) {
  const originalName = file.originalname || ''
  const fromName = originalName.includes('.')
    ? originalName.split('.').pop()
    : ''
  const fromMime = file.mimetype?.split('/')[1] || 'jpg'

  return (
    (fromName || fromMime)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') ||
    'jpg'
  )
}

async function removeTempFile(req) {
  if (!req.file?.path) return
  await unlink(req.file.path).catch(() => {})
}

function cleanupTempFile(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFile(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadReaderMailImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400

    return res.status(status).json({
      ok: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 300 KB or smaller'
          : error.message || 'Invalid image upload',
    })
  })
}

router.get(
  '/readers',
  requireAdmin,
  searchReadersForMail
)

router.get(
  '/history',
  requireAdmin,
  getAdminReaderMailHistory
)

router.get(
  '/logs',
  requireAdmin,
  getAdminReaderMailLogs
)

router.delete(
  '/:mailId',
  requireAdmin,
  deleteAdminReaderMail
)

router.put(
  '/:mailId',
  requireAdmin,
  updateAdminReaderMail
)

router.post(
  '/upload-image',
  requireAdmin,
  uploadReaderMailImage,
  cleanupTempFile,
  async (req, res) => {
    try {
      if (!req.file?.path) {
        return res.status(400).json({
          ok: false,
          message: 'Image file is required',
        })
      }

      if (!req.file.mimetype?.startsWith('image/')) {
        return res.status(400).json({
          ok: false,
          message: 'Only image files are allowed',
        })
      }

      const bucket = r2Bucket
      const publicBaseUrl = r2PublicUrl

      if (!bucket || !publicBaseUrl) {
        return res.status(500).json({
          ok: false,
          message: 'Cloudflare R2 is not configured',
        })
      }

      const ext = getSafeFileExt(req.file)
      const key =
        `reader-mails/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}.${ext}`

      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(req.file.path),
          ContentLength:
            Number(req.file.size || 0) ||
            undefined,
          ContentType: req.file.mimetype,
        })
      )

      const imageUrl =
        `${publicBaseUrl.replace(/\/$/, '')}/${key}`

      return res.status(200).json({
        ok: true,
        image_url: imageUrl,
      })
    } catch (error) {
      console.error(
        'UPLOAD READER MAIL IMAGE ERROR:',
        error
      )

      return res.status(500).json({
        ok: false,
        message:
          error.message ||
          'Failed to upload image',
      })
    }
  }
)

router.post(
  '/send',
  requireAdmin,
  sendReaderMailToOne
)

router.post(
  '/send-all',
  requireAdmin,
  sendReaderMailToAll
)

export default router
