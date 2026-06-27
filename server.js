import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import healthRoutes from './src/routes/health.routes.js'
import slidesRoutes from './src/routes/slides.routes.js'
import authRoutes from './src/routes/auth.routes.js'
import booksRoutes from './src/routes/books.routes.js'
import usersRoutes from './src/routes/users.routes.js'
import authorsRoutes from './src/routes/authors.routes.js'
import storiesRoutes from './src/routes/stories.routes.js'
import storyMediaRoutes from './src/routes/storyMedia.routes.js'
import publicStoriesRoutes from './src/routes/publicStories.routes.js'
import adminExclusiveRoutes from './src/routes/adminExclusive.routes.js'
import genresRoutes from './src/routes/genres.routes.js'
import commentsRoutes from './src/routes/comments.routes.js'
import reactionsRoutes from './src/routes/reactions.routes.js'
import adminCommentsRoutes from './src/routes/adminComments.routes.js'
import libraryRoutes from './src/routes/library.routes.js'
import purchaseRoutes from './src/routes/purchase.routes.js'
import adminPurchasesRoutes from './src/routes/adminPurchases.routes.js'
import adminActivityRoutes from './src/routes/adminActivity.routes.js'
import telegramRoutes from './src/routes/telegram.routes.js'
import { startTelegramUserListener } from './src/listeners/telegramUserListener.js'
import unlocksRoutes from './src/routes/unlocks.routes.js'
import shadowMallProductsRoutes from './src/routes/shadowMallProducts.routes.js'
import adminCommunityRoutes from './src/routes/adminCommunity.routes.js'
import adminSpamGuardRoutes from './src/routes/adminSpamGuard.routes.js'
import tasksRoutes from './src/routes/tasks.routes.js'
import adminStoriesRoutes from './src/routes/adminStories.routes.js'
import adminRankingRoutes from './src/routes/adminRanking.routes.js'
import notificationsRoutes from './src/routes/notifications.routes.js'
import readerMailsRoutes from './src/routes/readerMails.routes.js'
import adminNotificationsRoutes from './src/routes/adminNotifications.routes.js'
import advertisementsRoutes from './src/routes/advertisements.routes.js'
import adminBlockListRoutes from './src/routes/adminBlockList.routes.js'
import adminReaderMailsRoutes from './src/routes/adminReaderMails.routes.js'
import authorMediaRoutes from './src/routes/authorMedia.routes.js'
import authorStoreRoutes from './src/routes/authorStore.routes.js'
import adminIncomeRoutes from './src/routes/adminIncome.routes.js'
import visitorAnalyticsRoutes from './src/routes/visitorAnalytics.routes.js'
import { createSpamGuard } from './src/middleware/spamGuard.middleware.js'
import adminTaskCenterRoutes from './src/routes/adminTaskCenter.routes.js'
import adminLoginGuardRoutes from './src/routes/adminLoginGuard.routes.js'
import adminDeviceAccessRoutes from './src/routes/adminDeviceAccess.routes.js'
import adminTwoFactorRoutes from './src/routes/adminTwoFactor.routes.js'

dotenv.config()

const app = express()

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  'https://shadowerabook.site',
  'https://www.shadowerabook.site',
  'https://admin.shadowerabook.site',
  'https://shadow-backend-kucw.onrender.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
].filter(Boolean)

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error(`Not allowed by CORS: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Admin-Name',
    'X-Admin-Actor',
    'X-Admin-Id',
    'X-Shadow-Visitor-Id',
  ],
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

const visitorTrackingSpamGuard = createSpamGuard({
  scope: 'visitor_tracking',
  threshold: 60,
  windowSeconds: 60,
})

const accountAccessSpamGuard = createSpamGuard({
  scope: 'account_access',
  threshold: 120,
  windowSeconds: 60,
})

const readerActionSpamGuard = createSpamGuard({
  scope: 'reader_actions',
  threshold: 120,
  windowSeconds: 60,
})

const authorActionSpamGuard = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return readerActionSpamGuard(req, res, next)
  }
  return next()
}


const paymentSpamGuard = createSpamGuard({
  scope: 'payment_actions',
  threshold: 30,
  windowSeconds: 60,
  skipPaths: [
    '/api/purchase/aba/callback*',
  ],
})

app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'Shadow Backend API is running' })
})

app.use('/health', healthRoutes)
app.use('/api/auth', accountAccessSpamGuard, authRoutes)
app.use('/api/slides', slidesRoutes)
app.use('/api/books', booksRoutes)
app.use('/api/users', accountAccessSpamGuard, usersRoutes)
app.use('/api/authors', authorActionSpamGuard, authorsRoutes)
app.use('/api/stories', storiesRoutes)
app.use('/api/story-media', storyMediaRoutes)
app.use('/api/public', publicStoriesRoutes)
app.use('/api/admin/exclusive', adminExclusiveRoutes)
app.use('/api/admin/comments', adminCommentsRoutes)
app.use('/api/admin/purchases', adminPurchasesRoutes)
app.use('/api/admin/activity-logs', adminActivityRoutes)
app.use('/api/genres', genresRoutes)
app.use('/api/comments', readerActionSpamGuard, commentsRoutes)
app.use('/api/reactions', readerActionSpamGuard, reactionsRoutes)
app.use('/api/reader', readerActionSpamGuard, libraryRoutes)
app.use('/api/purchase', paymentSpamGuard, purchaseRoutes)
app.use('/api/telegram', telegramRoutes)
app.use('/api/unlocks', paymentSpamGuard, unlocksRoutes)
app.use('/api/shadow-mall', readerActionSpamGuard, shadowMallProductsRoutes)
app.use('/api/admin/community', adminCommunityRoutes)
app.use('/api/admin/spam-guard', adminSpamGuardRoutes)
app.use('/api/tasks', readerActionSpamGuard, tasksRoutes)
app.use('/api/notifications', readerActionSpamGuard, notificationsRoutes)
app.use('/api/admin/notifications', adminNotificationsRoutes)
app.use('/api/mails', readerActionSpamGuard, readerMailsRoutes)
app.use('/api/admin/stories', adminStoriesRoutes)
app.use('/api/admin/ranking', adminRankingRoutes)
app.use('/api/advertisements', advertisementsRoutes)
app.use('/api/admin/block-list', adminBlockListRoutes)
app.use('/api/admin/mails', adminReaderMailsRoutes)
app.use('/api/authors/media', readerActionSpamGuard, authorMediaRoutes)
app.use('/api/author-store', readerActionSpamGuard, authorStoreRoutes)
app.use('/api/admin/income', adminIncomeRoutes)
app.use('/api/visitors', visitorTrackingSpamGuard, visitorAnalyticsRoutes)
app.use('/api/task-center', adminTaskCenterRoutes)
app.use('/api/admin/login-guard', adminLoginGuardRoutes)
app.use('/api/admin/device-access', adminDeviceAccessRoutes)
app.use('/api/admin/two-factor', adminTwoFactorRoutes)

app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Route not found' })
})

app.use((error, req, res, next) => {
  console.error('SERVER ERROR:', error)
  res.status(500).json({ ok: false, message: 'Internal server error' })
})

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Shadow Backend running on port ${PORT}`)

  if (process.env.ENABLE_TELEGRAM_USER_LISTENER === 'true') {
    startTelegramUserListener().catch((error) => {
      console.error('TEMP_ABA_TELEGRAM_LISTENER_START_ERROR:', error)
    })
  }
})
