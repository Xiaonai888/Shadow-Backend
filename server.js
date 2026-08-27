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
import commentTrashRoutes from './src/routes/commentTrash.routes.js'
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
import chatRoutes from './src/routes/chat.routes.js'
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
import adminPasskeyPinRoutes from './src/routes/adminPasskeyPin.routes.js'
import contentVersionsRoutes from './src/routes/contentVersions.routes.js'
import giftsRoutes from './src/routes/gifts.routes.js'
import echoesRoutes from './src/routes/echoes.routes.js'
import echoV2Routes from './src/routes/echoV2.routes.js'
import authorStoriesRoutes from './src/routes/authorStories.routes.js'
import readerStoriesRoutes from './src/routes/readerStories.routes.js'
import discoverStoriesRoutes from './src/routes/discoverStories.routes.js'
import discoverSearchRoutes from './src/routes/discoverSearch.routes.js'
import { startReaderStoriesCleanup } from './src/controllers/readerStories.controller.js'
import { startAuthorStoriesCleanup } from './src/controllers/authorStories.controller.js'
import { startAuthorCommentCleanup } from './src/services/authorCommentCleanup.service.js'
import { startAuthorPostCleanup } from './src/services/authorPostCleanup.service.js'
import { startCommentTrashCleanup } from './src/services/commentTrashCleanup.service.js'
import fastRoutes from './src/routes/fast.routes.js'
import contentReportsRoutes from './src/routes/contentReports.routes.js'
import adminReportsRoutes from './src/routes/adminReports.routes.js'
import savedPostsRoutes from './src/routes/savedPosts.routes.js'
import helpCenterRoutes from './src/routes/helpCenter.routes.js'
import supportRequestsRoutes from './src/routes/supportRequests.routes.js'
import readerPostsRoutes from './src/routes/readerPosts.routes.js'
import readingProgressRoutes from './src/routes/readingProgress.routes.js'
import readerPresenceRoutes from './src/routes/readerPresence.routes.js'
import shareProfileRoutes from './src/routes/shareProfile.routes.js'
import adminChatStoryGalleryRoutes from './src/routes/adminChatStoryGallery.routes.js'
import adminMediaLibraryRoutes from './src/routes/adminMediaLibrary.routes.js'
import adminChatEvidenceRoutes from './src/routes/adminChatEvidence.routes.js'
import { startChatRetentionCleanup } from './src/services/chatRetentionCleanup.service.js'
import monthlyVoteRoutes from './src/routes/monthlyVote.routes.js'
import adminMonthlyVoteRoutes from './src/routes/adminMonthlyVote.routes.js'
import eventsRoutes from './src/routes/events.routes.js'
import adminEventsRoutes from './src/routes/adminEvents.routes.js'
import adminRolesRoutes from './src/routes/adminRoles.routes.js'
import adminAccountsRoutes from './src/routes/adminAccounts.routes.js'
import adminSearchInsightsRoutes from './src/routes/adminSearchInsights.routes.js'
import { startMangaR2DeleteRetryWorker } from './src/services/mangaR2DeleteRetry.service.js'
dotenv.config()

const app = express()

const STORAGE_CLEANUP_INTERVAL_MS =
  24 * 60 * 60 * 1000
let storageCleanupRunning = false

async function runStorageMigrationCleanupJob() {
  if (storageCleanupRunning) return

  storageCleanupRunning = true

  try {
    const {
      runStorageMigrationCleanup,
    } = await import(
      './src/services/storageMigrationCleanup.service.js'
    )

    const result =
      await runStorageMigrationCleanup()

    console.log(
      'STORAGE_MIGRATION_CLEANUP:',
      JSON.stringify({
        enabled: result.enabled,
        scanned: result.scanned,
        deleted: result.deleted,
        blocked_active_reference:
          result.blocked_active_reference,
        blocked_r2_verification:
          result.blocked_r2_verification,
        delete_failed:
          result.delete_failed,
        scan_failed:
          Boolean(result.scan_failed),
      })
    )
  } catch (error) {
    console.error(
      'STORAGE_MIGRATION_CLEANUP_ERROR:',
      error
    )
  } finally {
    storageCleanupRunning = false
  }
}

function startStorageMigrationCleanupScheduler() {
  const enabled =
    String(
      process.env
  .STORAGE_MIGRATION_CLEANUP_ENABLED ??
  'false'
    )
      .trim()
      .toLowerCase() !== 'false'

  if (!enabled) {
    console.log(
      'STORAGE_MIGRATION_CLEANUP: disabled'
    )
    return
  }

  runStorageMigrationCleanupJob()

  const timer = setInterval(
    runStorageMigrationCleanupJob,
    STORAGE_CLEANUP_INTERVAL_MS
  )

  timer.unref?.()
}

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

const readerReadSpamGuard = createSpamGuard({
  scope: 'reader_read',
  threshold: 300,
  windowSeconds: 60,
})

const communityWriteSpamGuard = createSpamGuard({
  scope: 'community_write',
  threshold: 120,
  windowSeconds: 60,
})

const episodeViewSpamGuard = createSpamGuard({
  scope: 'episode_views',
  threshold: 60,
  windowSeconds: 60,
})

const readingProgressWriteSpamGuard = createSpamGuard({
  scope: 'reading_progress',
  threshold: 120,
  windowSeconds: 60,
})

const taskProgressSpamGuard = createSpamGuard({
  scope: 'task_progress',
  threshold: 60,
  windowSeconds: 60,
})

const rewardActionSpamGuard = createSpamGuard({
  scope: 'reward_actions',
  threshold: 30,
  windowSeconds: 60,
})

const giftActionSpamGuard = createSpamGuard({
  scope: 'gift_actions',
  threshold: 30,
  windowSeconds: 60,
})

const supportActionSpamGuard = createSpamGuard({
  scope: 'support_actions',
  threshold: 20,
  windowSeconds: 60,
})

const reportActionSpamGuard = createSpamGuard({
  scope: 'report_actions',
  threshold: 20,
  windowSeconds: 60,
})

const authorContentSpamGuard = createSpamGuard({
  scope: 'author_content',
  threshold: 120,
  windowSeconds: 60,
})

const mediaUploadSpamGuard = createSpamGuard({
  scope: 'media_upload',
  threshold: 40,
  windowSeconds: 60,
})

const publicReadSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (
    req.method === 'POST' &&
    String(req.path || '').endsWith('/view')
  ) {
    return episodeViewSpamGuard(req, res, next)
  }

  return next()
}

const communityRouteSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return communityWriteSpamGuard(req, res, next)
}

const storyManagementSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return authorContentSpamGuard(req, res, next)
}

const mediaUploadRouteSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return mediaUploadSpamGuard(req, res, next)
}

const authorRouteSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (path.startsWith('/media')) {
    return next()
  }

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (
    path.includes('/payment-methods') ||
    path.includes('/page-notifications') ||
    path.includes('/story-notifications') ||
    path.includes('/story-notification-preferences')
  ) {
    return readerActionSpamGuard(req, res, next)
  }

  if (
    path.includes('/follow') ||
    path.includes('/reviews') ||
    path.includes('/posts') ||
    path.includes('/react') ||
    path.includes('/comments') ||
    path.includes('/echoes')
  ) {
    return communityWriteSpamGuard(req, res, next)
  }

  if (
    path === '/create' ||
    path === '/avatar' ||
    path === '/profile-images' ||
    path === '/me'
  ) {
    return authorContentSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
}

const taskSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (path.includes('/progress')) {
    return taskProgressSpamGuard(req, res, next)
  }

  if (path.includes('/claim')) {
    return rewardActionSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
}

const notificationSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
}

const mailSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (path.endsWith('/claim')) {
    return rewardActionSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
}

const readingProgressSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return readingProgressWriteSpamGuard(req, res, next)
}

const supportSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (path.startsWith('/admin/')) {
    return readerActionSpamGuard(req, res, next)
  }

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return supportActionSpamGuard(req, res, next)
}

const giftSpamGuard = (req, res, next) => {
  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  return giftActionSpamGuard(req, res, next)
}

const shortStorySpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (req.method === 'POST' && path.endsWith('/view')) {
    return episodeViewSpamGuard(req, res, next)
  }

  if (req.method === 'POST') {
    return mediaUploadSpamGuard(req, res, next)
  }

  return authorContentSpamGuard(req, res, next)
}

const shadowMallSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (
    path.startsWith('/orders') ||
    path.startsWith('/admin/')
  ) {
    return readerActionSpamGuard(req, res, next)
  }

  if (
    path.includes('/reaction') ||
    path.includes('/comments') ||
    path.includes('/echoes') ||
    path.includes('/wishlist')
  ) {
    return communityWriteSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
}

const authorStoreSpamGuard = (req, res, next) => {
  const path = String(req.path || '')

  if (req.method === 'GET') {
    return readerReadSpamGuard(req, res, next)
  }

  if (
    path.startsWith('/orders') ||
    path.startsWith('/admin/') ||
    path.startsWith('/telegram/webhook') ||
    path.includes('/withdrawals') ||
    path.includes('/sales-reports') ||
    path.includes('/telegram-settings')
  ) {
    return readerActionSpamGuard(req, res, next)
  }

  if (path.includes('/pdfs/')) {
    return mediaUploadSpamGuard(req, res, next)
  }

  if (
    path.startsWith('/me/products') ||
    path.startsWith('/me/categories') ||
    path.startsWith('/me/delivery-settings')
  ) {
    return authorContentSpamGuard(req, res, next)
  }

  return readerActionSpamGuard(req, res, next)
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
app.use('/api/slides', publicReadSpamGuard, slidesRoutes)
app.use('/api/books', publicReadSpamGuard, booksRoutes)
app.use('/api/users', accountAccessSpamGuard, usersRoutes)
app.use('/api/authors/media', mediaUploadRouteSpamGuard, authorMediaRoutes)
app.use('/api/authors', authorRouteSpamGuard, authorsRoutes)
app.use('/api/stories', storyManagementSpamGuard, storiesRoutes)
app.use('/api/story-media', mediaUploadRouteSpamGuard, storyMediaRoutes)
app.use('/api/public', publicReadSpamGuard)
app.use('/api/public', publicStoriesRoutes)
app.use('/api/admin/exclusive', adminExclusiveRoutes)
app.use('/api/admin/comments', adminCommentsRoutes)
app.use('/api/admin/purchases', adminPurchasesRoutes)
app.use('/api/admin/activity-logs', adminActivityRoutes)
app.use('/api/genres', publicReadSpamGuard, genresRoutes)
app.use('/api/comments', communityRouteSpamGuard, commentsRoutes)
app.use('/api/comment-trash', communityRouteSpamGuard, commentTrashRoutes)
app.use('/api/reactions', communityRouteSpamGuard, reactionsRoutes)
app.use('/api/echoes', communityRouteSpamGuard, echoesRoutes)
app.use('/api/echo-v2', communityRouteSpamGuard, echoV2Routes)
app.use('/api/reader', communityRouteSpamGuard, libraryRoutes)
app.use('/api/saved-posts', communityRouteSpamGuard, savedPostsRoutes)
app.use('/api/help-center', helpCenterRoutes)
app.use('/api/support', supportSpamGuard, supportRequestsRoutes)
app.use('/api/purchase', paymentSpamGuard, purchaseRoutes)
app.use('/api/telegram', telegramRoutes)
app.use('/api/unlocks', paymentSpamGuard, unlocksRoutes)
app.use('/api/shadow-mall', shadowMallSpamGuard, shadowMallProductsRoutes)
app.use('/api/admin/community', adminCommunityRoutes)
app.use('/api/admin/spam-guard', adminSpamGuardRoutes)
app.use('/api/tasks', taskSpamGuard, tasksRoutes)
app.use('/api/notifications', notificationSpamGuard, notificationsRoutes)
app.use('/api/admin/notifications', adminNotificationsRoutes)
app.use('/api/mails', mailSpamGuard, readerMailsRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/admin/stories', adminStoriesRoutes)
app.use('/api/admin/chat-story-gallery', adminChatStoryGalleryRoutes)
app.use('/api/admin/media-library', adminMediaLibraryRoutes)
app.use('/api/admin/ranking', adminRankingRoutes)
app.use('/api/advertisements', advertisementsRoutes)
app.use('/api/admin/block-list', adminBlockListRoutes)
app.use('/api/admin/mails', adminReaderMailsRoutes)
app.use('/api/author-store', authorStoreSpamGuard, authorStoreRoutes)
app.use('/api/admin/income', adminIncomeRoutes)
app.use('/api/visitors', visitorTrackingSpamGuard, visitorAnalyticsRoutes)
app.use('/api/task-center', adminTaskCenterRoutes)
app.use('/api/admin/login-guard', adminLoginGuardRoutes)
app.use('/api/admin/device-access', adminDeviceAccessRoutes)
app.use('/api/admin/two-factor', adminTwoFactorRoutes)
app.use('/api/admin/passkey-pin', adminPasskeyPinRoutes)
app.use('/api/public', contentVersionsRoutes)
app.use('/api/gifts', giftSpamGuard, giftsRoutes)
app.use('/api/author-stories', shortStorySpamGuard, authorStoriesRoutes)
app.use('/api/reader-stories', shortStorySpamGuard, readerStoriesRoutes)
app.use('/api/discover-stories', readerReadSpamGuard, discoverStoriesRoutes)
app.use('/api/discover-search', readerReadSpamGuard, discoverSearchRoutes)
app.use('/api/fast', mediaUploadRouteSpamGuard, fastRoutes)
app.use('/api/reports', reportActionSpamGuard, contentReportsRoutes)
app.use('/api/admin/reports', adminReportsRoutes)
app.use('/api/admin/chat-evidence', adminChatEvidenceRoutes)
app.use('/api/reader-posts', communityRouteSpamGuard, readerPostsRoutes)
app.use('/api/reading-progress', readingProgressSpamGuard, readingProgressRoutes)
app.use('/api/reader-presence', readerActionSpamGuard, readerPresenceRoutes)
app.use('/api/share-profile', mediaUploadRouteSpamGuard, shareProfileRoutes)
app.use('/api/monthly-vote', taskSpamGuard, monthlyVoteRoutes)
app.use('/api/admin/monthly-vote', adminMonthlyVoteRoutes)
app.use('/api/events', readerReadSpamGuard, eventsRoutes)
app.use('/api/admin/events', adminEventsRoutes)
app.use('/api/admin/roles', adminRolesRoutes)
app.use('/api/admin/accounts', adminAccountsRoutes)
app.use('/api/admin/search-insights', adminSearchInsightsRoutes)

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
  startAuthorStoriesCleanup()
  startReaderStoriesCleanup()
  startAuthorCommentCleanup()
  startAuthorPostCleanup()
  startCommentTrashCleanup()
  startChatRetentionCleanup()
  startStorageMigrationCleanupScheduler()
  void startMangaR2DeleteRetryWorker()

  if (process.env.ENABLE_TELEGRAM_USER_LISTENER === 'true') {
    startTelegramUserListener().catch((error) => {
      console.error('TEMP_ABA_TELEGRAM_LISTENER_START_ERROR:', error)
    })
  }
})
