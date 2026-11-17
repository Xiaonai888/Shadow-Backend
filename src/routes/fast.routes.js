import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'
import { createFastVideo, getReelYouTubeMetadata } from '../controllers/fastVideos.controller.js'
import { recordFastReelViewV2 } from '../controllers/fastReelViews.controller.js'

import {
  listMyFastNotInterested,
  setMyFastNotInterested,
  resetMyFastNotInterested,
} from '../controllers/fastNotInterested.controller.js'

import {
  listPublicFastVideos,
  getPublicFastVideo,
} from '../controllers/fastFeed.controller.js'

import fastLikesRouter from './fastLikes.routes.js'
import { getMyStudioCommunity } from '../controllers/shadowStudioCommunity.controller.js'
import { getPublicFastSaveCount } from '../controllers/fastSaves.controller.js'
import {
  listFastComments,
  createFastComment,
  updateFastComment,
  deleteFastComment,
  setFastCommentLike,
} from '../controllers/fastComments.controller.js'
import {
  listMyFastReels,
  updateMyFastReel,
  deleteMyFastReel,
} from '../controllers/fastReelManagement.controller.js'
import {
  listMyFastReelPlaylists,
  createFastReelPlaylist,
  updateFastReelPlaylist,
  deleteFastReelPlaylist,
  getFastReelPlaylistAssignments,
  setFastReelPlaylistAssignments,
} from '../controllers/fastReelPlaylists.controller.js'
import path from 'node:path'

const router = express.Router()

const fastVideoFeedLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_FEED_RATE_LIMITED',
    message: 'Too many video requests. Please try again shortly.',
  },
})

const fastVideoManageReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_MANAGE_READ_RATE_LIMITED',
    message: 'Too many Reel requests. Please try again shortly.',
  },
})

const fastVideoManageWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_MANAGE_WRITE_RATE_LIMITED',
    message: 'Too many Reel changes. Please try again shortly.',
  },
})

const fastVideoUploadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_THUMBNAIL_RATE_LIMITED',
    message: 'Too many thumbnail uploads. Please try again shortly.',
  },
})

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.mimetype)) {
      const error = new Error('Thumbnail must be JPG, JPEG, PNG, or WEBP')
      error.statusCode = 400
      return callback(error)
    }
    return callback(null, true)
  },
})

async function removeTempFile(req) {
  const fileName = req.file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return
  const expectedPath = path.join(os.tmpdir(), fileName)
  if (req.file.path !== expectedPath) return
  await unlink(expectedPath).catch(() => {})
}

function cleanupTempFile(req, res, next) {
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFile(req).catch(() => {})
  }
  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadThumbnail(req, res, next) {
  upload.single('thumbnail')(req, res, (error) => {
    if (!error) return next()
    removeTempFile(req).catch(() => {})
    return next(error)
  })
}

router.post(
  '/upload-thumbnail',
  fastVideoUploadLimit,
  requireUser,
  uploadThumbnail,
  cleanupTempFile,
  async (req, res) => {
    try {
      const userId = req.user?.user_id
      if (!userId) {
        return res.status(401).json({
          ok: false,
          message: 'Unauthorized',
        })
      }
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: 'Thumbnail file is required. Use form field name: thumbnail',
        })
      }

      const thumbnailUrl = await uploadImageToR2AsWebP(
        req.file,
        `fast/thumbnails/${userId}`,
        {
          width: 1280,
          height: 720,
          fit: 'cover',
          quality: 82,
          minQuality: 58,
          qualityStep: 6,
          maxBytes: 300 * 1024,
          fallbackWidth: 960,
          fallbackHeight: 540,
        }
      )

      return res.status(201).json({
        ok: true,
        message: 'Thumbnail uploaded and compressed successfully',
        thumbnail_url: thumbnailUrl,
        thumbnailUrl,
      })
    } catch (error) {
      console.error('FAST THUMBNAIL UPLOAD ERROR:', error)
      return res.status(error.statusCode || 500).json({
        ok: false,
        message: error.message || 'Failed to upload thumbnail',
      })
    }
  }
)

const VIEW_GATE_WINDOW_MS = 5 * 60 * 1000
const VIEW_GATE_MAX_ISSUES = 8
const VIEW_GATE_MAX_BUCKETS = 24

function createViewGateWindow(now) {
  return {
    startedAt: now,
    rejected: 0,
    buckets: new Map(),
    sampled: new Set(),
  }
}

let viewGateWindow = createViewGateWindow(Date.now())

function traceFastViewGate(req, res, next) {
  const startedAt = Date.now()
  const originalJson = res.json.bind(res)
  res.json = (payload) => {
    const status = Number(res.statusCode || 0)
    if (status === 401 || status === 403 || status === 429) {
      const now = Date.now()
      if (now - viewGateWindow.startedAt >= VIEW_GATE_WINDOW_MS) {
        if (viewGateWindow.rejected > 0) {
          console.warn('FAST_REEL_VIEW_GATE_SUMMARY', JSON.stringify({
            from: new Date(viewGateWindow.startedAt).toISOString(),
            to: new Date(now).toISOString(),
            rejected: viewGateWindow.rejected,
            reasons: Object.fromEntries(viewGateWindow.buckets),
          }))
        }
        viewGateWindow = createViewGateWindow(now)
      }

      const fallbackCode = status === 429
        ? 'FAST_REEL_VIEW_RATE_LIMITED'
        : status === 401 ? 'REEL_VIEW_UNAUTHORIZED' : 'REEL_VIEW_FORBIDDEN'
      const code = String(payload?.code || fallbackCode)
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 64) || fallbackCode
      const key = `${status}_${code}`
      const bucket = viewGateWindow.buckets.has(key)
        ? key : viewGateWindow.buckets.size < VIEW_GATE_MAX_BUCKETS ? key : 'OTHER'
      viewGateWindow.buckets.set(bucket, (viewGateWindow.buckets.get(bucket) || 0) + 1)
      viewGateWindow.rejected += 1

      markRequestDiagnostic({
        feature: 'fast_reel_view_v2',
        stage: status === 429 ? 'rate_limit' : 'auth_gate',
        error_code: code,
        view_http_status: status,
        view_mode: req.body?.mode === 'qualified' ? 'qualified' : 'fast',
        view_duration_ms: now - startedAt,
      })

      if (!viewGateWindow.sampled.has(key) && viewGateWindow.sampled.size < VIEW_GATE_MAX_ISSUES) {
        viewGateWindow.sampled.add(key)
        console.warn('FAST_REEL_VIEW_GATE_ISSUE', JSON.stringify({
          status,
          code,
          mode: req.body?.mode === 'qualified' ? 'qualified' : 'fast',
        }))
      }
    }
    return originalJson(payload)
  }
  next()
}

const fastVideoViewWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_REEL_VIEW_RATE_LIMITED',
    message: 'Too many Reel playback reports.',
  },
})

router.post(
  '/videos/:id/view/v2',
  traceFastViewGate,
  fastVideoViewWriteLimit,
  requireUser,
  recordFastReelViewV2
)

router.get(
  '/videos/youtube-metadata/:youtubeId',
  fastVideoManageReadLimit,
  requireUser,
  getReelYouTubeMetadata
)

router.get('/studio/community', fastVideoManageReadLimit, requireUser, getMyStudioCommunity)
router.get('/videos/mine', fastVideoManageReadLimit, requireUser, listMyFastReels)
router.patch('/videos/:id', fastVideoManageWriteLimit, requireUser, updateMyFastReel)
router.delete('/videos/:id', fastVideoManageWriteLimit, requireUser, deleteMyFastReel)

router.get('/playlists/mine', fastVideoManageReadLimit, requireUser, listMyFastReelPlaylists)
router.post('/playlists', fastVideoManageWriteLimit, requireUser, createFastReelPlaylist)
router.patch('/playlists/:playlistId', fastVideoManageWriteLimit, requireUser, updateFastReelPlaylist)
router.delete('/playlists/:playlistId', fastVideoManageWriteLimit, requireUser, deleteFastReelPlaylist)
router.get('/videos/:id/playlists', fastVideoManageReadLimit, requireUser, getFastReelPlaylistAssignments)
router.put('/videos/:id/playlists', fastVideoManageWriteLimit, requireUser, setFastReelPlaylistAssignments)

const fastCommentReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 450,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many comment requests. Please try again.' },
})
const fastCommentWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 45,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many comment changes. Please try again.' },
})

router.get('/videos/:id/comments', fastCommentReadLimit, listFastComments)
router.post('/videos/:id/comments', fastCommentWriteLimit, requireUser, createFastComment)
router.patch('/videos/:id/comments/:commentId', fastCommentWriteLimit, requireUser, updateFastComment)
router.delete('/videos/:id/comments/:commentId', fastCommentWriteLimit, requireUser, deleteFastComment)
router.put('/videos/:id/comments/:commentId/like', fastCommentWriteLimit, requireUser, setFastCommentLike)

router.get('/videos/:id/saves', fastVideoFeedLimit, getPublicFastSaveCount)

router.use('/videos', fastLikesRouter)

router.get(
  '/videos/not-interested/mine',
  fastVideoManageReadLimit,
  requireUser,
  listMyFastNotInterested
)

router.delete(
  '/videos/not-interested/mine',
  fastVideoManageWriteLimit,
  requireUser,
  resetMyFastNotInterested
)

router.put(
  '/videos/:id/not-interested/me',
  fastVideoManageWriteLimit,
  requireUser,
  setMyFastNotInterested
)

router.get('/videos', fastVideoFeedLimit, listPublicFastVideos)
router.get('/videos/:id', fastVideoFeedLimit, getPublicFastVideo)
router.post('/videos', fastVideoManageWriteLimit, requireUser, createFastVideo)
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      ok: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Thumbnail must be 5 MB or smaller'
          : error.message,
    })
  }
  if (error) {
    return res.status(error.statusCode || 400).json({
      ok: false,
      message: error.message || 'Thumbnail upload failed',
    })
  }
  return next()
})

export default router
