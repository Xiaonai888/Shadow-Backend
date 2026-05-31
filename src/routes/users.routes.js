import express from 'express'
import {
  getPublicUserProfile,
  followUser,
  unfollowUser,
  getCurrentUser,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  updateUserAvatar,
  updateUserProfile,
} from '../controllers/users.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/register', registerUser)
router.post('/login', loginUser)
router.post('/forgot-password', requestPasswordReset)
router.post('/reset-password', resetPassword)
router.get('/me', requireUser, getCurrentUser)
router.put('/avatar', requireUser, updateUserAvatar)
router.put('/profile', requireUser, updateUserProfile)
router.get('/:username/profile', requireUser, getPublicUserProfile)
router.post('/:username/follow', requireUser, followUser)
router.delete('/:username/follow', requireUser, unfollowUser)

export default router
