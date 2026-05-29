import express from 'express'
import {
  getAdminStories,
  getAdminStoriesOverview,
  getAdminStoryById,
  issueStoryWarning,
  updateAuthorAdminStatus,
  updateStoryAdminVisibility,
} from '../controllers/adminStories.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/overview', requireAdmin, getAdminStoriesOverview)
router.get('/', requireAdmin, getAdminStories)
router.get('/:storyId', requireAdmin, getAdminStoryById)
router.patch('/:storyId/visibility', requireAdmin, updateStoryAdminVisibility)
router.post('/:storyId/warnings', requireAdmin, issueStoryWarning)
router.patch('/authors/:authorId/status', requireAdmin, updateAuthorAdminStatus)

export default router
