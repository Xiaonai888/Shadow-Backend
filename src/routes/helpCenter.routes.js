import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createAdminHelpArticle,
  createAdminHelpCategory,
  deleteAdminHelpArticle,
  deleteAdminHelpCategory,
  getAdminHelpArticles,
  getAdminHelpCategories,
  getPublicHelpArticleById,
  getPublicHelpArticles,
  getPublicHelpCategories,
  getPublicHelpCenter,
  reorderAdminHelpArticles,
  reorderAdminHelpCategories,
  updateAdminHelpArticle,
  updateAdminHelpCategory,
} from '../controllers/helpCenter.controller.js'

const router = express.Router()

const publicHelpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'HELP_CENTER_READ_RATE_LIMIT',
    message: 'Too many help center requests. Please retry shortly.',
  },
})

const adminHelpReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'HELP_CENTER_ADMIN_READ_RATE_LIMIT',
    message: 'Too many admin help requests. Please retry shortly.',
  },
})

const adminHelpWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'HELP_CENTER_ADMIN_WRITE_RATE_LIMIT',
    message: 'Too many admin help changes. Please retry shortly.',
  },
})

router.get('/', publicHelpLimit, getPublicHelpCenter)
router.get('/categories', publicHelpLimit, getPublicHelpCategories)
router.get('/articles', publicHelpLimit, getPublicHelpArticles)
router.get('/articles/:articleId', publicHelpLimit, getPublicHelpArticleById)

router.get('/admin/categories', adminHelpReadLimit, requireAdmin, getAdminHelpCategories)
router.post('/admin/categories', adminHelpWriteLimit, requireAdmin, createAdminHelpCategory)
router.put('/admin/categories/reorder', adminHelpWriteLimit, requireAdmin, reorderAdminHelpCategories)
router.put('/admin/categories/:categoryId', adminHelpWriteLimit, requireAdmin, updateAdminHelpCategory)
router.delete('/admin/categories/:categoryId', adminHelpWriteLimit, requireAdmin, deleteAdminHelpCategory)

router.get('/admin/articles', adminHelpReadLimit, requireAdmin, getAdminHelpArticles)
router.post('/admin/articles', adminHelpWriteLimit, requireAdmin, createAdminHelpArticle)
router.put('/admin/articles/reorder', adminHelpWriteLimit, requireAdmin, reorderAdminHelpArticles)
router.put('/admin/articles/:articleId', adminHelpWriteLimit, requireAdmin, updateAdminHelpArticle)
router.delete('/admin/articles/:articleId', adminHelpWriteLimit, requireAdmin, deleteAdminHelpArticle)

export default router
