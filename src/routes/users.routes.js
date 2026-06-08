import express from 'express'
import {
  followUser,
  getCurrentUser,
  getPublicUserProfile,
  getUserFollowers,
  getUserFollowing,
  getUserSuggestions,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  unfollowUser,
  updateUserAvatar,
  updateUserProfile,
} from '../controllers/users.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { verifyTurnstile } from '../middleware/turnstile.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

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

router.post('/register', readerRegisterLimit, verifyTurnstile, registerUser)
router.post('/login', readerLoginLimit, loginUser)
router.post('/forgot-password', readerPasswordRequestLimit, requestPasswordReset)
router.post('/reset-password', readerPasswordResetLimit, resetPassword)
router.get('/me', requireUser, getCurrentUser)
router.get('/suggestions', requireUser, getUserSuggestions)
router.put('/avatar', requireUser, updateUserAvatar)
router.put('/profile', requireUser, updateUserProfile)
router.get('/:username/profile', requireUser, getPublicUserProfile)
router.get('/:username/followers', requireUser, getUserFollowers)
router.get('/:username/following', requireUser, getUserFollowing)
router.post('/:username/follow', requireUser, followUser)
router.delete('/:username/follow', requireUser, unfollowUser)

export default router
