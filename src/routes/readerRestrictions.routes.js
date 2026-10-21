import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  listMyRestrictedReaders,
  searchReadersForRestriction,
  restrictReader,
  unrestrictReader,
} from '../controllers/readerRestrictions.controller.js'

const router = express.Router()
const readLimit = createRateLimit({
  key: 'reader-restrictions-read',
  windowMs: 60000,
  max: 60,
  identity: (req) => req.user?.user_id,
})
const writeLimit = createRateLimit({
  key: 'reader-restrictions-write',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id,
})

router.use(requireUser)
router.get('/', readLimit, listMyRestrictedReaders)
router.get('/search', readLimit, searchReadersForRestriction)
router.post('/:readerId', writeLimit, restrictReader)
router.delete('/:readerId', writeLimit, unrestrictReader)

export default router
