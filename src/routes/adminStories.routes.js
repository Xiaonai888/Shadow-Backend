import express from 'express'
import { rateLimit } from 'express-rate-limit'
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
import { getAdminStoryGrowthDaily } from '../controllers/adminStoryGrowth.controller.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

const viewStories = requireAdminPermission('stories.view')
const manageStories = requireAdminPermission('stories.manage')

// Limit the new growth endpoint by IP before checking the admin session.
const storyGrowthDailyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_STORY_GROWTH_RATE_LIMIT',
    message: 'Too many Story Growth requests. Please retry shortly.',
  },
})

function invalidatePublicStoriesAfterMutation(
  _req,
  res,
  next
) {
  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

router.get('/overview', viewStories, getAdminStoriesOverview)
router.get('/update-activity', viewStories, getAdminStoryUpdateActivity)
router.get('/growth/daily', storyGrowthDailyLimit, viewStories, getAdminStoryGrowthDaily)
router.get('/picker', viewStories, getAdminStoryPicker)
router.get('/', viewStories, getAdminStories)
router.get('/:storyId', viewStories, getAdminStoryById)
router.get('/:storyId/media/:mediaType/:mediaIndex/download', viewStories, downloadAdminStoryMedia)

router.patch(
  '/:storyId/visibility',
  manageStories,
  invalidatePublicStoriesAfterMutation,
  updateStoryAdminVisibility
)
router.post('/:storyId/warnings', manageStories, issueStoryWarning)
router.patch('/authors/:authorId/status', manageStories, updateAuthorAdminStatus)

export default router
