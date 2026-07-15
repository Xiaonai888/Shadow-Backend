import express from 'express'
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

router.get('/', getPublicHelpCenter)
router.get('/categories', getPublicHelpCategories)
router.get('/articles', getPublicHelpArticles)
router.get('/articles/:articleId', getPublicHelpArticleById)

router.get('/admin/categories', requireAdmin, getAdminHelpCategories)
router.post('/admin/categories', requireAdmin, createAdminHelpCategory)
router.put('/admin/categories/reorder', requireAdmin, reorderAdminHelpCategories)
router.put('/admin/categories/:categoryId', requireAdmin, updateAdminHelpCategory)
router.delete('/admin/categories/:categoryId', requireAdmin, deleteAdminHelpCategory)

router.get('/admin/articles', requireAdmin, getAdminHelpArticles)
router.post('/admin/articles', requireAdmin, createAdminHelpArticle)
router.put('/admin/articles/reorder', requireAdmin, reorderAdminHelpArticles)
router.put('/admin/articles/:articleId', requireAdmin, updateAdminHelpArticle)
router.delete('/admin/articles/:articleId', requireAdmin, deleteAdminHelpArticle)

export default router
