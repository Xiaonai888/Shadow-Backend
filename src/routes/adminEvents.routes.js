import express from 'express'
import { listActiveEvents } from '../controllers/events.controller.js'

const router = express.Router()

router.get('/', listActiveEvents)

export default router
