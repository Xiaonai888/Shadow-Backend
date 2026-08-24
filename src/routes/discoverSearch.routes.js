import express from 'express'
import { searchDiscover } from '../controllers/discoverSearch.controller.js'
import { recordDiscoverSearchClick } from '../controllers/discoverSearchAnalytics.controller.js'

const router = express.Router()

router.get('/', searchDiscover)
router.post('/click', recordDiscoverSearchClick)

export default router
