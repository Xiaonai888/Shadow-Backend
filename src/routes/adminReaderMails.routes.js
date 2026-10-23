import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { rateLimit } from 'express-rate-limit'
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
import path from 'node:path'

const router = express.Router()

const adminMailReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_READER_MAIL_READ_RATE_LIMIT',
    message: 'Too many mail requests. Please retry shortly.',
  },
})

const adminMailWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_READER_MAIL_WRITE_RATE_LIMIT',
    message: 'Too many mail actions. Please retry shortly.',
  },
})

const adminMailUploadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_READER_MAIL_UPLOAD_RATE_LIMIT',
    message: 'Too many mail image uploads. Please retry shortly.',
  },
})

const adminMailBroadcastLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_READER_MAIL_BROADCAST_RATE_LIMIT',
    message: 'Too many broadcast requests. Please retry shortly.',
  },
})

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

function getSafeMailTempPath(file) {
  const fileName = file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return ''
  const expectedPath = path.join(os.tmpdir(), fileName)
  return file.path === expectedPath ? expectedPath : ''
}

async function removeTempFile(req) {
  const tempPath = getSafeMailTempPath(req.file)
  if (!tempPath) return
  await unlink(tempPath).catch(() => {})
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
  adminMailReadLimit,
  requireAdmin,
  searchReadersForMail
)

router.get(
  '/history',
  adminMailReadLimit,
  requireAdmin,
  getAdminReaderMailHistory
)

router.get(
  '/logs',
  adminMailReadLimit,
  requireAdmin,
  getAdminReaderMailLogs
)

router.delete(
  '/:mailId',
  adminMailWriteLimit,
  requireAdmin,
  deleteAdminReaderMail
)

router.put(
  '/:mailId',
  adminMailWriteLimit,
  requireAdmin,
  updateAdminReaderMail
)

router.post(
  '/upload-image',
  adminMailUploadLimit,
  requireAdmin,
  uploadReaderMailImage,
  cleanupTempFile,
  async (req, res) => {
    try {
      const tempFilePath = getSafeMailTempPath(req.file)
      if (!tempFilePath) {
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
          Body: createReadStream(tempFilePath),
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
  adminMailWriteLimit,
  requireAdmin,
  sendReaderMailToOne
)

router.post(
  '/send-all',
  adminMailBroadcastLimit,
  requireAdmin,
  sendReaderMailToAll
)

export default router
