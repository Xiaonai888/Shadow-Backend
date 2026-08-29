import { getMyAuthorDashboard } from '../controllers/authorDashboard.controller.js'
import { getMyAuthorDashboardBadges } from '../controllers/authorDashboardBadges.controller.js'
import { getFollowedAuthorPostsFeed } from '../controllers/followedAuthorPostsFeed.controller.js'
import { getDiscoverAuthorSuggestions } from '../controllers/authorDiscovery.controller.js'
import { getDiscoverAuthorPostsFeed } from '../controllers/discoverAuthorPostsFeed.controller.js'
import { inviteAuthorPageFriend } from '../controllers/authorPageInvites.controller.js'
import { getAuthorHashtagSuggestions } from '../controllers/authorHashtags.controller.js'
import express from 'express'

import {
  deleteMyAuthorStoryNotification,
  getMyAuthorStoryNotifications,
  markAllMyAuthorStoryNotificationsRead,
  markMyAuthorStoryNotificationRead,
  markMyAuthorStoryNotificationUnread,
  updateMyAuthorStoryNotificationPreference,
} from '../controllers/authorStoryNotifications.controller.js'

import {
  updateMyAuthorPage,
  createAuthorPage,
  followAuthorPage,
  getAuthorPageFollowers,
  getAuthorPageReviews,
  upsertMyAuthorPageReview,
  deleteMyAuthorPageReview,
  getFollowedAuthorPages,
  getMyAuthorPage,
  getPublicAuthorPage,
  getTopAuthorPages,
  unfollowAuthorPage,
} from '../controllers/authors.controller.js'
import {
  updateAuthorAvatar,
  updateAuthorProfileImages,
} from '../controllers/authorProfileMedia.controller.js'
import {
  createAuthorPostComment,
  deleteOwnAuthorPostComment,
  getAuthorPagePosts,
  getAuthorPostById,
  getAuthorPostComments,
  getAuthorPostCommentById,
  getAuthorPostCommentReplies,
  setAuthorPostCommentHidden,
  getAuthorPostReactions,
  setMyAuthorPostPinned,
  setMyAuthorPostReaction,
  toggleAuthorPostCommentLike,
  updateOwnAuthorPostComment,
} from '../controllers/authorPosts.controller.js'
import {
  createMyAuthorPost,
  updateMyAuthorPost,
} from '../controllers/authorPostMediaGuard.controller.js'

import {
  getMyAuthorPostNotificationPreference,
  updateMyAuthorPostNotificationPreference,
} from '../controllers/authorPostNotifications.controller.js'

import {
  getMyAuthorPostTrash,
  moveMyAuthorPostToTrash,
  restoreMyAuthorPostFromTrash,
} from '../controllers/authorPostTrash.controller.js'

import {
  createAuthorPostEcho,
  getAuthorPostEchoes,
} from '../controllers/authorPostEchoes.controller.js'

import {
  activateMyAuthorLifetimeBoost,
  getMyAuthor49DayEvent,
  getMyAuthorIncome,
  getMyAuthorPaymentMethods,
  getMyAuthorQuest,
  saveMyAuthorPaymentMethod,
} from '../controllers/authorRevenue.controller.js'
import {
  getMyAuthorDiamonds,
  getMyAuthorGifts,
} from '../controllers/authorAssets.controller.js'
import {
  createMyAuthorBlockedWord,
  deleteMyAuthorBlockedWord,
  getMyAuthorBlockedWords,
} from '../controllers/authorBlockedWords.controller.js'
import {
  getMyAuthorHiddenComments,
  reviewMyAuthorHiddenComment,
} from '../controllers/authorHiddenComments.controller.js'
import {
  createMyAuthorBlockedReader,
  deleteMyAuthorBlockedReader,
  getMyAuthorBlockedReaders,
  getMyAuthorBlockStories,
  searchMyAuthorReaders,
} from '../controllers/authorBlockedReaders.controller.js'
import {
  getMyAuthorCommentCleanupSettings,
  getMyAuthorModerationHistory,
  runMyAuthorCommentCleanupNow,
  updateMyAuthorCommentCleanupSettings,
} from '../controllers/authorCommentProtectionSettings.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

import {
  deleteMyAuthorPageNotification,
  getMyAuthorPageNotificationUnreadCount,
  streamMyAuthorPageNotifications,
  getMyAuthorPageNotifications,
  markAllMyAuthorPageNotificationsRead,
  markMyAuthorPageNotificationRead,
  markMyAuthorPageNotificationUnread,
  updateMyAuthorPageNotificationPreference,
} from '../controllers/authorPageNotifications.controller.js'

import {
  blockReaderAuthorPage,
  getReaderAuthorPageBlockStatus,
  unblockReaderAuthorPage,
} from '../controllers/readerAuthorPageBlocks.controller.js'

const router = express.Router()

router.get('/me/49-day-event', requireUser, getMyAuthor49DayEvent)
router.get('/me/dashboard', requireUser, getMyAuthorDashboard)
router.get('/me/dashboard-badges', requireUser, getMyAuthorDashboardBadges)
router.get('/me', requireUser, getMyAuthorPage)
router.get('/me/quest', requireUser, getMyAuthorQuest)
router.post('/me/quest/boost/activate', requireUser, activateMyAuthorLifetimeBoost)
router.get('/me/income', requireUser, getMyAuthorIncome)
router.get('/me/diamonds', requireUser, getMyAuthorDiamonds)
router.get('/me/gifts', requireUser, getMyAuthorGifts)
router.get('/me/comment-protection/blocked-words', requireUser, getMyAuthorBlockedWords)
router.post('/me/comment-protection/blocked-words', requireUser, createMyAuthorBlockedWord)
router.delete('/me/comment-protection/blocked-words/:wordId', requireUser, deleteMyAuthorBlockedWord)
router.get('/me/comment-protection/hidden-comments', requireUser, getMyAuthorHiddenComments)
router.patch('/me/comment-protection/hidden-comments/:reviewId', requireUser, reviewMyAuthorHiddenComment)
router.get('/me/comment-protection/blocked-readers', requireUser, getMyAuthorBlockedReaders)
router.get('/me/comment-protection/blocked-readers/search', requireUser, searchMyAuthorReaders)
router.get('/me/comment-protection/blocked-readers/stories', requireUser, getMyAuthorBlockStories)
router.post('/me/comment-protection/blocked-readers', requireUser, createMyAuthorBlockedReader)
router.delete('/me/comment-protection/blocked-readers/:blockId', requireUser, deleteMyAuthorBlockedReader)
router.get('/me/comment-protection/cleanup-settings', requireUser, getMyAuthorCommentCleanupSettings)
router.put('/me/comment-protection/cleanup-settings', requireUser, updateMyAuthorCommentCleanupSettings)
router.post('/me/comment-protection/cleanup/run', requireUser, runMyAuthorCommentCleanupNow)
router.get('/me/comment-protection/moderation-history', requireUser, getMyAuthorModerationHistory)
router.get('/me/payment-methods', requireUser, getMyAuthorPaymentMethods)
router.get('/me/page-notifications', requireUser, getMyAuthorPageNotifications)
router.get('/me/page-notifications/unread-count', requireUser, getMyAuthorPageNotificationUnreadCount)
router.get('/me/page-notifications/stream', requireUser, streamMyAuthorPageNotifications)
router.patch('/me/page-notifications/read-all', requireUser, markAllMyAuthorPageNotificationsRead)
router.patch('/me/page-notifications/:id/read', requireUser, markMyAuthorPageNotificationRead)
router.patch('/me/page-notifications/:id/unread', requireUser, markMyAuthorPageNotificationUnread)
router.delete('/me/page-notifications/:id', requireUser, deleteMyAuthorPageNotification)
router.get('/me/story-notifications', requireUser, getMyAuthorStoryNotifications)
router.patch('/me/story-notifications/read-all', requireUser, markAllMyAuthorStoryNotificationsRead)
router.patch('/me/story-notifications/:id/read', requireUser, markMyAuthorStoryNotificationRead)
router.patch('/me/story-notifications/:id/unread', requireUser, markMyAuthorStoryNotificationUnread)
router.delete('/me/story-notifications/:id', requireUser, deleteMyAuthorStoryNotification)
router.put('/me/page-notification-preferences/:type', requireUser, updateMyAuthorPageNotificationPreference)
router.put('/me/story-notification-preferences/:type', requireUser, updateMyAuthorStoryNotificationPreference)
router.get('/following', requireUser, getFollowedAuthorPages)
router.get('/following/posts/feed', requireUser, getFollowedAuthorPostsFeed)
router.get('/discover', requireUser, getDiscoverAuthorSuggestions)
router.get('/hashtags/suggest', requireUser, getAuthorHashtagSuggestions)
router.get('/discover/posts/feed', requireUser, getDiscoverAuthorPostsFeed)
router.get('/top', getTopAuthorPages)
router.get('/page/:pageUsername/followers', getAuthorPageFollowers)
router.get('/page/:pageUsername/reviews', getAuthorPageReviews)
router.put('/page/:pageUsername/reviews/me', requireUser, upsertMyAuthorPageReview)
router.delete('/page/:pageUsername/reviews/me', requireUser, deleteMyAuthorPageReview)
router.get('/page/:pageUsername/block-status', requireUser, getReaderAuthorPageBlockStatus)
router.post('/page/:pageUsername/block', requireUser, blockReaderAuthorPage)
router.delete('/page/:pageUsername/block', requireUser, unblockReaderAuthorPage)
router.get('/page/:pageUsername', getPublicAuthorPage)
router.post('/page/:pageUsername/follow', requireUser, followAuthorPage)
router.delete('/page/:pageUsername/follow', requireUser, unfollowAuthorPage)
router.post('/me/payment-methods', requireUser, saveMyAuthorPaymentMethod)
router.post('/create', requireUser, createAuthorPage)
router.put('/avatar', requireUser, updateAuthorAvatar)
router.put('/profile-images', requireUser, updateAuthorProfileImages)
router.put('/me', requireUser, updateMyAuthorPage)
router.get('/page/:pageUsername/posts', getAuthorPagePosts)
router.post('/me/posts', requireUser, createMyAuthorPost)
router.get('/me/posts/trash', requireUser, getMyAuthorPostTrash)
router.patch('/me/posts/:postId', requireUser, updateMyAuthorPost)
router.patch('/me/posts/:postId/pin', requireUser, setMyAuthorPostPinned)
router.patch('/me/posts/:postId/trash', requireUser, moveMyAuthorPostToTrash)
router.patch('/me/posts/:postId/restore', requireUser, restoreMyAuthorPostFromTrash)
router.post('/me/posts/:postId/react', requireUser, setMyAuthorPostReaction)
router.get('/page/posts/:postId/notification-preference', requireUser, getMyAuthorPostNotificationPreference)
router.put('/page/posts/:postId/notification-preference', requireUser, updateMyAuthorPostNotificationPreference)
router.get('/page/posts/:postId', getAuthorPostById)
router.get('/page/posts/:postId/reactions', getAuthorPostReactions)
router.get('/page/posts/:postId/comments', getAuthorPostComments)
router.get('/page/posts/:postId/comments/:commentId', getAuthorPostCommentById)
router.get('/page/posts/:postId/comments/:commentId/replies', getAuthorPostCommentReplies)
router.post('/me/posts/:postId/comments', requireUser, createAuthorPostComment)
router.patch('/me/post-comments/:commentId', requireUser, updateOwnAuthorPostComment)
router.post('/me/post-comments/:commentId/like', requireUser, toggleAuthorPostCommentLike)
router.patch('/me/post-comments/:commentId/visibility', requireUser, setAuthorPostCommentHidden)
router.delete('/me/post-comments/:commentId', requireUser, deleteOwnAuthorPostComment)
router.get('/page/posts/:postId/echoes', requireUser, getAuthorPostEchoes)
router.post('/page/posts/:postId/echoes', requireUser, createAuthorPostEcho)
router.post('/page/:pageUsername/invite', requireUser, inviteAuthorPageFriend)

export default router
