import express from 'express'
import readerSecurityRoutes from './readerSecurity.routes.js'
import readerHiddenWordsRoutes from './readerHiddenWords.routes.js'
import readerTagsMentionsRoutes from './readerTagsMentions.routes.js'
import readerCommentSettingsRoutes from './readerCommentSettings.routes.js'
import readerMessagesRepliesSettingsRoutes from './readerMessagesRepliesSettings.routes.js'
import readerRestrictionSettingsRoutes from './readerRestrictionSettings.routes.js'
import readerRestrictionsRoutes from './readerRestrictions.routes.js'
import { getReaderAccountPrivacy, updateReaderAccountPrivacy } from '../controllers/readerAccountPrivacy.controller.js'
import {
  getMeSummary,
  followUser,
  getCurrentUser,
  getPublicUserProfile,
  getUserFollowers,
  getUserFollowing,
  getUserSuggestions,
  loginUser,
  verifyReaderLogin,
  registerUser,
  requestPasswordReset,
  resetPassword,
  changePassword,
  requestEmailChange,
  confirmEmailChange,
  unfollowUser,
  updatePaymentProfile,
  updateDateOfBirth,
  updateUserAvatar,
  updateUserProfile,
} from '../controllers/users.controller.js'
import { searchReaderBlockTargets } from '../controllers/readerBlockSearch.controller.js'
import { getMyReaderBlockedList } from '../controllers/readerBlockedList.controller.js'
import { blockReaderAccount, unblockReaderAccount } from '../controllers/readerAccountBlocks.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import readerDeviceAccessRoutes from './readerDeviceAccess.routes.js'
import { verifyTurnstile } from '../middleware/turnstile.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { rateLimit } from 'express-rate-limit'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

const readerRegisterLimit = createRateLimit({
  key: 'reader-register',
  windowMs: 600000,
  max: 5,
  message: 'Too many account creation attempts. Please wait and try again.',
})

const readerLoginLimit = createRateLimit({
  key: 'reader-login',
  windowMs: 60000,
  max: 20,
  message: 'Too many login attempts. Please wait and try again.',
})

const readerPasswordRequestLimit = createRateLimit({
  key: 'reader-password-request',
  windowMs: 600000,
  max: 5,
  message: 'Too many password reset requests. Please wait and try again.',
})

const readerPasswordResetLimit = createRateLimit({
  key: 'reader-password-reset',
  windowMs: 600000,
  max: 10,
  message: 'Too many password reset attempts. Please wait and try again.',
})

const readerChangePasswordLimit = createRateLimit({
  key: 'reader-change-password',
  windowMs: 600000,
  max: 10,
  message: 'Too many password change attempts. Please wait and try again.',
})

const readerEmailChangeRequestLimit = createRateLimit({
  key: 'reader-email-change-request',
  windowMs: 600000,
  max: 5,
  message: 'Too many email change requests. Please wait and try again.',
})

const readerEmailChangeConfirmLimit = createRateLimit({
  key: 'reader-email-change-confirm',
  windowMs: 600000,
  max: 10,
  message: 'Too many email verification attempts. Please wait and try again.',
})

const readerProtectedRouteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `reader:${req.user.user_id}`,
  message: {
    ok: false,
    code: 'READER_RATE_LIMIT',
    message: 'Too many requests. Please wait before trying again.',
  },
})

function invalidatePublicStoriesAfterMutation(req, res, next) {
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

router.post('/register', readerRegisterLimit, verifyTurnstile, registerUser)
router.post('/login', readerLoginLimit, loginUser)
router.post('/login/verify', readerLoginLimit, verifyReaderLogin)
router.post('/forgot-password', readerPasswordRequestLimit, requestPasswordReset)
router.post('/reset-password', readerPasswordResetLimit, resetPassword)
router.use('/devices', readerDeviceAccessRoutes)
router.use('/security', readerSecurityRoutes)
router.use('/me/hidden-words', readerHiddenWordsRoutes)
router.use('/me/tags-mentions', readerTagsMentionsRoutes)
router.use('/me/comment-settings', readerCommentSettingsRoutes)
router.use('/me/messages-replies', readerMessagesRepliesSettingsRoutes)
router.use('/me/restriction-settings', readerRestrictionSettingsRoutes)
router.use('/me/restricted-readers', readerRestrictionsRoutes)
router.get('/me', requireUser, getCurrentUser)
router.get('/me/privacy', requireUser, getReaderAccountPrivacy)
router.put('/me/privacy', requireUser, updateReaderAccountPrivacy)
router.get('/me/summary', requireUser, getMeSummary)
router.get('/me/block-targets/search', requireUser, searchReaderBlockTargets)
router.get('/me/blocked', requireUser, getMyReaderBlockedList)
router.post('/me/blocked/readers/:readerId', requireUser, blockReaderAccount)
router.delete('/me/blocked/readers/:readerId', requireUser, unblockReaderAccount)
router.get('/suggestions', requireUser, getUserSuggestions)
router.put('/avatar', requireUser, updateUserAvatar)
router.put('/profile', requireUser, updateUserProfile)
router.put(
  '/date-of-birth',
  requireUser,
  invalidatePublicStoriesAfterMutation,
  updateDateOfBirth
)
router.put('/change-password', readerChangePasswordLimit, requireUser, readerProtectedRouteLimit, changePassword)
router.post(
  '/email-change/request',
  readerEmailChangeRequestLimit,
  requireUser,
  readerProtectedRouteLimit,
  requestEmailChange
)
router.post(
  '/email-change/confirm',
  readerEmailChangeConfirmLimit,
  requireUser,
  readerProtectedRouteLimit,
  confirmEmailChange
)
router.put('/payment-profile', requireUser, readerProtectedRouteLimit, updatePaymentProfile)
router.get('/:username/profile', requireUser, readerProtectedRouteLimit, getPublicUserProfile)
router.get('/:username/followers', requireUser, readerProtectedRouteLimit, getUserFollowers)
router.get('/:username/following', requireUser, readerProtectedRouteLimit, getUserFollowing)
router.post('/:username/follow', requireUser, readerProtectedRouteLimit, followUser)
router.delete('/:username/follow', requireUser, readerProtectedRouteLimit, unfollowUser)

export default router
