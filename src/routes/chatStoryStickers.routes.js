import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStickerPacks,
  getPackStickers,
  getMyStickerCollection,
  addMyStickerPack,
  removeMyStickerPack,
  reorderMyStickerPacks,
  addStickerFavorite,
  removeStickerFavorite,
  recordStickerUse,
} from '../controllers/chatStoryStickers.controller.js'

const router = express.Router()
const keyGenerator = req => String(req.user?.user_id || ipKeyGenerator(req.ip))
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator,
  message: { ok: false, code: 'STICKER_READ_LIMIT', message: 'Too many sticker requests' },
})
const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator,
  message: { ok: false, code: 'STICKER_WRITE_LIMIT', message: 'Too many sticker updates' },
})

router.use(requireUser)
router.get('/packs', readLimit, getStickerPacks)
router.get('/packs/:folderId/images', readLimit, getPackStickers)
router.get('/me', readLimit, getMyStickerCollection)
router.post('/me/packs', writeLimit, addMyStickerPack)
router.delete('/me/packs/:folderId', writeLimit, removeMyStickerPack)
router.put('/me/packs/order', writeLimit, reorderMyStickerPacks)
router.post('/me/favorites', writeLimit, addStickerFavorite)
router.delete('/me/favorites/:imageId', writeLimit, removeStickerFavorite)
router.post('/me/used', writeLimit, recordStickerUse)

export default router
