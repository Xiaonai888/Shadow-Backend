import express from 'express'
import { searchDiscover } from '../controllers/discoverSearch.controller.js'

const router = express.Router()

router.get('/', searchDiscover)

export default router
