import express from 'express'
import { supabase } from '../config/supabase.js'
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

const readerAuthSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READER_AUTH_RATE_LIMIT',
    message: 'Too many account requests. Please wait before trying again.',
  },
})

const readerProfileRouteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `reader:${req.user.user_id}`,
  message: {
    ok: false,
    code: 'READER_PROFILE_RATE_LIMIT',
    message: 'Too many profile requests. Please wait before trying again.',
  },
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

router.post('/register', readerRegisterLimit, readerAuthSafetyLimit, verifyTurnstile, registerUser)
router.post('/login', readerLoginLimit, readerAuthSafetyLimit, loginUser)
router.post('/login/verify', readerLoginLimit, readerAuthSafetyLimit, verifyReaderLogin)
router.post('/forgot-password', readerPasswordRequestLimit, readerAuthSafetyLimit, requestPasswordReset)
router.post('/reset-password', readerPasswordResetLimit, readerAuthSafetyLimit, resetPassword)
router.use('/devices', readerDeviceAccessRoutes)
router.use('/security', readerSecurityRoutes)
router.use('/me/hidden-words', readerHiddenWordsRoutes)
router.use('/me/tags-mentions', readerTagsMentionsRoutes)
router.use('/me/comment-settings', readerCommentSettingsRoutes)
router.use('/me/messages-replies', readerMessagesRepliesSettingsRoutes)
router.use('/me/restriction-settings', readerRestrictionSettingsRoutes)
router.use('/me/restricted-readers', readerRestrictionsRoutes)
router.use(readerAuthSafetyLimit)
router.get('/me', requireUser, readerProfileRouteLimit, getCurrentUser)
// Story Language is an account preference, not an IP/country restriction.
const ALLOWED_STORY_LANGUAGES = new Set(['km', 'en', 'zh', 'ja', 'ko'])

function publicStoryLanguage(row) {
  const language = row?.story_language || 'km'
  return {
    story_language: language,
    story_language_updated_at: row?.story_language_updated_at || null,
    synced: Boolean(row?.story_language_updated_at),
    mission_audience: language === 'km' ? 'khmer' : 'international',
  }
}

router.get('/me/story-language', requireUser, readerProfileRouteLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try {
    const userId = req.user.user_id || req.user.id
    const { data, error } = await supabase
      .from('users')
      .select('story_language, story_language_updated_at')
      .eq('id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, code: 'READER_NOT_FOUND' })
    return res.json({ ok: true, ...publicStoryLanguage(data) })
  } catch (error) {
    console.error('GET STORY LANGUAGE ERROR:', error?.code || error?.message)
    return res.status(500).json({ ok: false, code: 'STORY_LANGUAGE_READ_FAILED' })
  }
})

router.put('/me/story-language', requireUser, readerProfileRouteLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const language = typeof req.body?.story_language === 'string'
    ? req.body.story_language.trim().toLowerCase()
    : ''

  if (!ALLOWED_STORY_LANGUAGES.has(language)) {
    return res.status(400).json({ ok: false, code: 'INVALID_STORY_LANGUAGE' })
  }

  try {
    const userId = req.user.user_id || req.user.id
    const { data: current, error: readError } = await supabase
      .from('users')
      .select('story_language, story_language_updated_at')
      .eq('id', userId)
      .maybeSingle()

    if (readError) throw readError
    if (!current) return res.status(404).json({ ok: false, code: 'READER_NOT_FOUND' })

    // No redundant writes on refresh. First explicit sync is timestamped even for km.
    if (current.story_language === language && current.story_language_updated_at) {
      return res.json({ ok: true, unchanged: true, ...publicStoryLanguage(current) })
    }

    const { data, error } = await supabase
      .from('users')
      .update({ story_language: language, story_language_updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('story_language, story_language_updated_at')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, code: 'READER_NOT_FOUND' })
    return res.json({ ok: true, unchanged: false, ...publicStoryLanguage(data) })
  } catch (error) {
    console.error('SAVE STORY LANGUAGE ERROR:', error?.code || error?.message)
    return res.status(500).json({ ok: false, code: 'STORY_LANGUAGE_SAVE_FAILED' })
  }
})

router.get('/me/privacy', requireUser, readerProfileRouteLimit, getReaderAccountPrivacy)
router.put('/me/privacy', requireUser, readerProfileRouteLimit, updateReaderAccountPrivacy)
router.get('/me/summary', requireUser, readerProfileRouteLimit, getMeSummary)
router.get('/me/block-targets/search', requireUser, readerProfileRouteLimit, searchReaderBlockTargets)
router.get('/me/blocked', requireUser, readerProfileRouteLimit, getMyReaderBlockedList)
router.post('/me/blocked/readers/:readerId', requireUser, readerProfileRouteLimit, blockReaderAccount)
router.delete('/me/blocked/readers/:readerId', requireUser, readerProfileRouteLimit, unblockReaderAccount)
router.get('/suggestions', requireUser, readerProfileRouteLimit, getUserSuggestions)
router.put('/avatar', requireUser, readerProfileRouteLimit, updateUserAvatar)
router.put('/profile', requireUser, readerProfileRouteLimit, updateUserProfile)
router.put(
  '/date-of-birth',
  requireUser,
  readerProfileRouteLimit,
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
