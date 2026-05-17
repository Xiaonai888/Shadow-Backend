import express from 'express'
import {
  createAuthorPage,
  getMyAuthorPage,
  updateAuthorAvatar,
} from '../controllers/authors.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me', requireUser, getMyAuthorPage)
router.post('/create', requireUser, createAuthorPage)
router.put('/avatar', requireUser, updateAuthorAvatar)

export default router
