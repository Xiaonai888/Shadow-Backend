import { getAdminMusicListens } from '../controllers/musicListenAdmin.controller.js'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { recordMusicListen } from '../controllers/musicListen.controller.js'
import {
  createMusicArtist,
  createMusicRelease,
  createMusicSong,
  deleteMusicArtist,
  deleteMusicRelease,
  deleteMusicSong,
  getAdminMusicArtist,
  getAdminMusicOverview,
  getPublicMusicArtist,
  getPublicMusicArtists,
  getMyMusicArtistFollows,
  followMusicArtist,
  unfollowMusicArtist,
  updateMusicArtist,
  updateMusicRelease,
  updateMusicSong,
} from '../controllers/music.controller.js'

const router = express.Router()

const musicPublicReadLimit = rateLimit({
  windowMs: 60000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MUSIC_PUBLIC_READ_RATE_LIMIT', message: 'Too many music requests. Please retry shortly.' },
})

const musicReaderReadLimit = rateLimit({
  windowMs: 60000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MUSIC_READER_READ_RATE_LIMIT', message: 'Too many music requests. Please retry shortly.' },
})

const musicReaderActionLimit = rateLimit({
  windowMs: 60000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MUSIC_READER_ACTION_RATE_LIMIT', message: 'Too many music actions. Please retry shortly.' },
})

const musicAdminReadLimit = rateLimit({
  windowMs: 60000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MUSIC_ADMIN_READ_RATE_LIMIT', message: 'Too many admin music requests. Please retry shortly.' },
})

const musicAdminWriteLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MUSIC_ADMIN_WRITE_RATE_LIMIT', message: 'Too many admin music changes. Please retry shortly.' },
})

router.get('/artists', musicPublicReadLimit, getPublicMusicArtists)
router.get('/artists/:artistId', musicPublicReadLimit, getPublicMusicArtist)
router.get('/follows', musicReaderReadLimit, requireUser, getMyMusicArtistFollows)
router.post('/artists/:artistId/follow', musicReaderActionLimit, requireUser, followMusicArtist)
router.delete('/artists/:artistId/follow', musicReaderActionLimit, requireUser, unfollowMusicArtist)
router.post('/songs/:songId/listen', musicReaderActionLimit, requireUser, recordMusicListen)

router.get('/admin/artists', musicAdminReadLimit, requireAdmin, getAdminMusicOverview)
router.get('/admin/artists/:artistId', musicAdminReadLimit, requireAdmin, getAdminMusicArtist)
router.get('/admin/listens', musicAdminReadLimit, requireAdmin, getAdminMusicListens)
router.post('/admin/artists', musicAdminWriteLimit, requireAdmin, createMusicArtist)
router.patch('/admin/artists/:artistId', musicAdminWriteLimit, requireAdmin, updateMusicArtist)
router.delete('/admin/artists/:artistId', musicAdminWriteLimit, requireAdmin, deleteMusicArtist)

router.post('/admin/releases', musicAdminWriteLimit, requireAdmin, createMusicRelease)
router.patch('/admin/releases/:releaseId', musicAdminWriteLimit, requireAdmin, updateMusicRelease)
router.delete('/admin/releases/:releaseId', musicAdminWriteLimit, requireAdmin, deleteMusicRelease)

router.post('/admin/songs', musicAdminWriteLimit, requireAdmin, createMusicSong)
router.patch('/admin/songs/:songId', musicAdminWriteLimit, requireAdmin, updateMusicSong)
router.delete('/admin/songs/:songId', musicAdminWriteLimit, requireAdmin, deleteMusicSong)

export default router
