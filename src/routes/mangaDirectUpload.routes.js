import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createMangaDirectUploadSession,
  finalizeMangaDirectUploadSession,
  cancelMangaDirectUploadSession,
} from '../services/mangaDirectUpload.service.js'
import { wakeHeavyMediaWorkerCoordinator } from '../services/heavyMediaWorkerCoordinator.service.js'

const router = express.Router()

const mangaDirectSessionLimit = rateLimit({
  windowMs: 60000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.spamGuard?.identity_type === 'account' && req.spamGuard.guard_key
      ? req.spamGuard.guard_key
      : ipKeyGenerator(req.ip),
  message: {
    ok: false,
    code: 'MANGA_DIRECT_RATE_LIMIT',
    message: 'Too many upload session requests. Please retry shortly.',
  },
})

function handleRoute(operation, successStatus = 200) {
  return async (req, res) => {
    try {
      const userId = req.user?.user_id
      if (!userId) {
        return res.status(401).json({
          ok: false,
          code: 'MANGA_DIRECT_UNAUTHORIZED',
          stage: 'auth',
          message: 'Please sign in before uploading Manga images.',
        })
      }
      const result = await operation({ userId, body: req.body || {} })
      return res.status(successStatus).json(result)
    } catch (error) {
      const status = Number(error?.statusCode)
      const expected = Number.isInteger(status) && status >= 400 && status < 600
      if (!expected) console.error('MANGA_DIRECT_ROUTE_ERROR:', error)
      return res.status(expected ? status : 503).json({
        ok: false,
        code: expected ? String(error.code || 'MANGA_DIRECT_FAILED') : 'MANGA_DIRECT_UNAVAILABLE',
        stage: expected ? String(error.stage || 'upload') : 'storage',
        message: expected ? error.message : 'Manga upload is temporarily unavailable.',
      })
    }
  }
}

router.post('/init', mangaDirectSessionLimit, requireUser, handleRoute(
  ({ userId, body }) => createMangaDirectUploadSession({
    userId,
    fileSize: body.file_size,
    mimeType: body.mime_type,
    fileName: body.file_name,
  }),
  201
))

router.post('/finalize', mangaDirectSessionLimit, requireUser, handleRoute(async ({ userId, body }) => {
  const result = await finalizeMangaDirectUploadSession({
    userId,
    uploadToken: body.upload_token,
  })
  wakeHeavyMediaWorkerCoordinator()
  return result
}, 202))

router.post('/cancel', mangaDirectSessionLimit, requireUser, handleRoute(
  ({ userId, body }) => cancelMangaDirectUploadSession({
    userId,
    uploadToken: body.upload_token,
  })
))

export default router
