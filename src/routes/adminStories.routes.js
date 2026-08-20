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
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()

const viewStories = requireAdminPermission('stories.view')
const manageStories = requireAdminPermission('stories.manage')

router.get('/overview', viewStories, getAdminStoriesOverview)
router.get('/update-activity', viewStories, getAdminStoryUpdateActivity)
router.get('/picker', viewStories, getAdminStoryPicker)
router.get('/', viewStories, getAdminStories)
router.get('/:storyId', viewStories, getAdminStoryById)
router.get('/:storyId/media/:mediaType/:mediaIndex/download', viewStories, downloadAdminStoryMedia)

router.patch('/:storyId/visibility', manageStories, updateStoryAdminVisibility)
router.post('/:storyId/warnings', manageStories, issueStoryWarning)
router.patch('/authors/:authorId/status', manageStories, updateAuthorAdminStatus)

export default router
