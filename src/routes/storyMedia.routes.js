import {
  cleanupTemporaryMangaPartsV2,
  uploadMangaPageImageV2,
} from '../controllers/mangaImageUploadV2.controller.js'
import express from 'express'
import multer from 'multer'
import { uploadStoryImage } from '../controllers/storyMedia.controller.js'
import {
  uploadMangaPageImage,
  uploadNovelEpisodeImage,
} from '../controllers/episodeImageUpload.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import {
  guardMangaTempUploadMemory,
  guardMangaUploadMemory,
} from '../services/memoryGuard.service.js'
import {
  stageMangaV2UploadToR2,
} from '../middleware/mangaTempUpload.middleware.js'

const router = express.Router()

const NOVEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const MANGA_PAGE_MAX_BYTES = 5 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

function readImageStream(kind, maxBytes) {
  return (req, res, next) => {
    const isNovel = kind === 'novel'
    const expectedBytes = Number(req.headers['content-length'] || 0)

    if (expectedBytes > maxBytes) {
      return res.status(413).json({
        ok: false,
        code: isNovel
          ? 'NOVEL_IMAGE_TOO_LARGE'
          : 'MANGA_PAGE_TOO_LARGE',
        stage: 'receive',
        message: isNovel
          ? 'Novel image must be 5 MB or smaller.'
          : 'Manga page must be 5 MB or smaller.',
        expected_bytes: expectedBytes,
        max_bytes: maxBytes,
      })
    }

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      return next()
    }

    const chunks = []
    let receivedBytes = 0
    let finished = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
    }

    const fail = (status, payload) => {
      if (finished) return
      finished = true
      cleanup()
      return res.status(status).json(payload)
    }

    const onData = (chunk) => {
      if (finished) return

      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)

      receivedBytes += buffer.length

      if (receivedBytes > maxBytes) {
        req.pause()

        fail(413, {
          ok: false,
          code: isNovel
            ? 'NOVEL_IMAGE_TOO_LARGE'
            : 'MANGA_PAGE_TOO_LARGE',
          stage: 'receive',
          message: isNovel
            ? 'Novel image must be 5 MB or smaller.'
            : 'Manga page must be 5 MB or smaller.',
          received_bytes: receivedBytes,
          max_bytes: maxBytes,
        })

        req.resume()
        return
      }

      chunks.push(buffer)
    }

    const onEnd = () => {
      if (finished) return

      if (receivedBytes === 0) {
        fail(400, {
          ok: false,
          code: 'IMAGE_STREAM_EMPTY',
          stage: 'receive',
          message:
            'The browser reached the server but sent 0 image bytes. Please choose the image again and retry.',
          received_bytes: 0,
          expected_bytes: expectedBytes,
          content_type: String(req.headers['content-type'] || ''),
        })
        return
      }

      if (
        expectedBytes > 0 &&
        receivedBytes !== expectedBytes
      ) {
        fail(400, {
          ok: false,
          code: 'IMAGE_UPLOAD_SIZE_MISMATCH',
          stage: 'receive',
          message:
            'The image upload was incomplete because the received file size did not match the expected size. Please try again.',
          received_bytes: receivedBytes,
          expected_bytes: expectedBytes,
        })
        return
      }

      finished = true
      cleanup()
      req.body = Buffer.concat(chunks, receivedBytes)
      next()
    }

    const onAborted = () => {
      fail(400, {
        ok: false,
        code: 'IMAGE_UPLOAD_INTERRUPTED',
        stage: 'receive',
        message:
          'The upload connection ended before the server received the complete image. Please check the connection and try again.',
        received_bytes: receivedBytes,
        expected_bytes: expectedBytes,
      })
    }

    const onError = (error) => {
      fail(400, {
        ok: false,
        code: 'IMAGE_STREAM_READ_FAILED',
        stage: 'receive',
        message:
          'The server could not read the incoming image stream. Please try again.',
        reason: String(error?.message || 'unknown_stream_error'),
        received_bytes: receivedBytes,
        expected_bytes: expectedBytes,
      })
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('aborted', onAborted)
    req.on('error', onError)

    if (req.readableEnded) {
      onEnd()
    }
  }
}

router.post(
  '/upload-novel-image',
  requireUser,
  readImageStream('novel', NOVEL_IMAGE_MAX_BYTES),
  uploadNovelEpisodeImage
)

router.post(
  '/upload-manga-page',
  requireUser,
  guardMangaUploadMemory,
  readImageStream('manga', MANGA_PAGE_MAX_BYTES),
  uploadMangaPageImage
)

router.post(
  '/upload-manga-page-v2',
  requireUser,
  guardMangaTempUploadMemory,
  stageMangaV2UploadToR2,
  uploadMangaPageImageV2
)

router.post(
  '/cleanup-manga-page-v2',
  requireUser,
  cleanupTemporaryMangaPartsV2
)

router.post('/upload-image', requireUser, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400

    return res.status(status).json({
      ok: false,
      code: error.code || 'UPLOAD_ERROR',
      message: error.message,
    })
  })
}, uploadStoryImage)

export default router
