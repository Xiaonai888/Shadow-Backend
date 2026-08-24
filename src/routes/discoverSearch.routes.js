import express from 'express'
import { searchDiscover } from '../controllers/discoverSearch.controller.js'
import {
  recordDiscoverSearchClick,
  recordDiscoverSearchEvent,
} from '../controllers/discoverSearchAnalytics.controller.js'

const router = express.Router()

router.get('/', searchDiscover)
router.post('/analytics', recordDiscoverSearchEvent)
router.post('/click', recordDiscoverSearchClick)

export default router
