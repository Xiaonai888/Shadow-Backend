import express from 'express'
import { translateStory } from '../controllers/storyTranslation.controller.js'

const router = express.Router()

router.post('/', (req, res) => {
  if (process.env.STORY_TRANSLATION_ENABLED !== 'true') {
    return res.status(503).json({ ok: false, code: 'STORY_TRANSLATION_DISABLED' })
  }

  return translateStory(req, res)
})

export default router
