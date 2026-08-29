import express from 'express'
import { translateStory } from '../controllers/storyTranslation.controller.js'

const router = express.Router()

router.post('/', translateStory)

export default router
