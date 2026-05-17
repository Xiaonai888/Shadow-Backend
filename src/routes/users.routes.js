import express from 'express'
import {
  getCurrentUser,
  loginUser,
  registerUser,
  updateUserAvatar,
  updateUserProfile,
} from '../controllers/users.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/register', registerUser)
router.post('/login', loginUser)
router.get('/me', requireUser, getCurrentUser)
router.put('/avatar', requireUser, updateUserAvatar)
router.put('/profile', requireUser, updateUserProfile)

export default router
