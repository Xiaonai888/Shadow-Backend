import {
  followUser,
  getCurrentUser,
  getPublicUserProfile,
  getUserFollowers,
  getUserFollowing,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  unfollowUser,
  updateUserAvatar,
  updateUserProfile,
} from '../controllers/users.controller.js'

const router = express.Router()

router.post('/register', registerUser)
router.post('/login', loginUser)
router.post('/forgot-password', requestPasswordReset)
router.post('/reset-password', resetPassword)
router.get('/me', requireUser, getCurrentUser)
router.put('/avatar', requireUser, updateUserAvatar)
router.put('/profile', requireUser, updateUserProfile)
router.get('/:username/profile', requireUser, getPublicUserProfile)
router.get('/:username/followers', requireUser, getUserFollowers)
router.get('/:username/following', requireUser, getUserFollowing)
router.post('/:username/follow', requireUser, followUser)
router.delete('/:username/follow', requireUser, unfollowUser)
router.get('/:username/followers', requireUser, getUserFollowers)
router.get('/:username/following', requireUser, getUserFollowing)

export default router
