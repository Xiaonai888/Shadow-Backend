import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  changePasskeyPin,
  disablePasskeyPin,
  getPasskeyPinEvents,
  getPasskeyPinStatus,
  setupPasskeyPin,
  verifyPasskeyPin,
} from '../controllers/adminPasskeyPin.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/status', getPasskeyPinStatus)
router.post('/setup', setupPasskeyPin)
router.post('/verify', verifyPasskeyPin)
router.post('/change', changePasskeyPin)
router.post('/disable', disablePasskeyPin)
router.get('/events', getPasskeyPinEvents)

export default router
