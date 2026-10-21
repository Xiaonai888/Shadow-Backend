import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderRestrictionSettings,
  updateMyReaderRestrictionSetting,
} from '../controllers/readerRestrictionSettings.controller.js'

const router = express.Router()

router.get('/', requireUser, getMyReaderRestrictionSettings)
router.patch('/', requireUser, updateMyReaderRestrictionSetting)

export default router
