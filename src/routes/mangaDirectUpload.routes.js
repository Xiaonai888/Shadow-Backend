import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createMangaDirectUploadSession,
  finalizeMangaDirectUploadSession,
  cancelMangaDirectUploadSession,
} from '../services/mangaDirectUpload.service.js'
import { wakeHeavyMediaWorkerCoordinator } from '../services/heavyMediaWorkerCoordinator.service.js'

const router = express.Router()

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

router.post('/init', requireUser, handleRoute(
  ({ userId, body }) => createMangaDirectUploadSession({
    userId,
    fileSize: body.file_size,
    mimeType: body.mime_type,
    fileName: body.file_name,
  }),
  201
))

router.post('/finalize', requireUser, handleRoute(async ({ userId, body }) => {
  const result = await finalizeMangaDirectUploadSession({
    userId,
    uploadToken: body.upload_token,
  })
  wakeHeavyMediaWorkerCoordinator()
  return result
}, 202))

router.post('/cancel', requireUser, handleRoute(
  ({ userId, body }) => cancelMangaDirectUploadSession({
    userId,
    uploadToken: body.upload_token,
  })
))

export default router
