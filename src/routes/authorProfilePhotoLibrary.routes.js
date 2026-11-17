import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyAuthorProfilePhotos,
  selectMyAuthorProfilePhoto,
  removeMyAuthorProfilePhoto,
} from '../controllers/authorProfilePhotoLibrary.controller.js'

const router = express.Router()
const readLimit = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false })

router.use(requireUser)
router.get('/', readLimit, listMyAuthorProfilePhotos)
router.put('/active', writeLimit, selectMyAuthorProfilePhoto)
router.delete('/:assetId', writeLimit, removeMyAuthorProfilePhoto)

export default router
