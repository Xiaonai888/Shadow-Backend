import express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { wakeStoryEpisodePushScheduler } from '../services/storyEpisodePushScheduler.js'

const router = express.Router()

router.post('/wake', (req, res) => {
  const expected = String(process.env.STORY_EPISODE_PUSH_WAKE_SECRET || '').trim()
  const received = String(req.get('x-shadow-story-push-wake') || '').trim()

  if (expected.length < 32 || !received || received.length > 1024) {
    return res.status(403).json({ ok: false })
  }

  const expectedHash = createHash('sha256').update(expected).digest()
  const receivedHash = createHash('sha256').update(received).digest()

  if (!timingSafeEqual(expectedHash, receivedHash)) {
    return res.status(403).json({ ok: false })
  }

  const scheduled = wakeStoryEpisodePushScheduler()
  return res.status(202).json({ ok: true, scheduled })
})

export default router
