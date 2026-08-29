import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
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
  updateMusicArtist,
  updateMusicRelease,
  updateMusicSong,
} from '../controllers/music.controller.js'

const router = express.Router()

router.get('/artists', getPublicMusicArtists)
router.get('/artists/:artistId', getPublicMusicArtist)

router.get('/admin/artists', requireAdmin, getAdminMusicOverview)
router.get('/admin/artists/:artistId', requireAdmin, getAdminMusicArtist)
router.post('/admin/artists', requireAdmin, createMusicArtist)
router.patch('/admin/artists/:artistId', requireAdmin, updateMusicArtist)
router.delete('/admin/artists/:artistId', requireAdmin, deleteMusicArtist)

router.post('/admin/releases', requireAdmin, createMusicRelease)
router.patch('/admin/releases/:releaseId', requireAdmin, updateMusicRelease)
router.delete('/admin/releases/:releaseId', requireAdmin, deleteMusicRelease)

router.post('/admin/songs', requireAdmin, createMusicSong)
router.patch('/admin/songs/:songId', requireAdmin, updateMusicSong)
router.delete('/admin/songs/:songId', requireAdmin, deleteMusicSong)

export default router
