import express from 'express'
import {
  getAdminStories,
  getAdminStoriesOverview,
  getAdminStoryById,
  getAdminStoryPicker,
  getAdminStoryUpdateActivity,
  issueStoryWarning,
  updateAuthorAdminStatus,
  updateStoryAdminVisibility,
  downloadAdminStoryMedia
} from '../controllers/adminStories.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/overview', requireAdmin, getAdminStoriesOverview)
router.get('/update-activity', requireAdmin, getAdminStoryUpdateActivity)
router.get('/picker', requireAdmin, getAdminStoryPicker)
router.get('/', requireAdmin, getAdminStories)
router.get('/:storyId', requireAdmin, getAdminStoryById)
router.get('/:storyId/media/:mediaType/:mediaIndex/download', requireAdmin, downloadAdminStoryMedia)
router.patch('/:storyId/visibility', requireAdmin, updateStoryAdminVisibility)
router.post('/:storyId/warnings', requireAdmin, issueStoryWarning)
router.patch('/authors/:authorId/status', requireAdmin, updateAuthorAdminStatus)

export default router
