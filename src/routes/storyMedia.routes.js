import express from 'express'
import multer from 'multer'
import { uploadStoryImage } from '../controllers/storyMedia.controller.js'
import {
  uploadMangaPageImage,
  uploadNovelEpisodeImage,
} from '../controllers/episodeImageUpload.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const NOVEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const MANGA_PAGE_MAX_BYTES = 2 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

const novelRawParser = express.raw({
  type: () => true,
  limit: NOVEL_IMAGE_MAX_BYTES,
})

const mangaRawParser = express.raw({
  type: () => true,
  limit: MANGA_PAGE_MAX_BYTES,
})

function rawUploadParser(parser, kind, maxBytes) {
  return (req, res, next) => {
    parser(req, res, (error) => {
      if (!error) return next()

      const isNovel = kind === 'novel'

      if (error.type === 'entity.too.large') {
        return res.status(413).json({
          ok: false,
          code: isNovel ? 'NOVEL_IMAGE_TOO_LARGE' : 'MANGA_PAGE_TOO_LARGE',
          stage: 'receive',
          message: isNovel
            ? 'Novel image must be 5 MB or smaller.'
            : 'Manga page must be 2 MB or smaller.',
          max_bytes: maxBytes,
        })
      }

      if (error.type === 'request.aborted') {
        return res.status(400).json({
          ok: false,
          code: 'IMAGE_UPLOAD_INTERRUPTED',
          stage: 'receive',
          message: 'The upload connection ended before the server received the complete image. Please check the connection and try again.',
          received_bytes: Number(error.received || 0),
          expected_bytes: Number(error.expected || 0),
        })
      }

      if (error.type === 'request.size.invalid') {
        return res.status(400).json({
          ok: false,
          code: 'IMAGE_UPLOAD_SIZE_MISMATCH',
          stage: 'receive',
          message: 'The image upload was incomplete because the received file size did not match the expected size. Please try again.',
          received_bytes: Number(error.received || 0),
          expected_bytes: Number(error.expected || 0),
        })
      }

      return res.status(error.status || 400).json({
        ok: false,
        code: 'RAW_IMAGE_RECEIVE_FAILED',
        stage: 'receive',
        message: 'The server could not finish receiving the image. Please try again.',
        reason: String(error.type || error.message || 'unknown_receive_error'),
      })
    })
  }
}

router.post(
  '/upload-novel-image',
  requireUser,
  rawUploadParser(novelRawParser, 'novel', NOVEL_IMAGE_MAX_BYTES),
  uploadNovelEpisodeImage
)

router.post(
  '/upload-manga-page',
  requireUser,
  rawUploadParser(mangaRawParser, 'manga', MANGA_PAGE_MAX_BYTES),
  uploadMangaPageImage
)

router.post('/upload-image', requireUser, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return res.status(status).json({
      ok: false,
      code: error.code || 'UPLOAD_ERROR',
      message: error.message,
    })
  })
}, uploadStoryImage)

export default router
