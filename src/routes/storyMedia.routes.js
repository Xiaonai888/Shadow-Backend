import {
  cleanupTemporaryMangaPartsV2,
  getMangaPageImageV2JobStatus,
  uploadMangaPageImageV2,
} from '../controllers/mangaImageUploadV2.controller.js'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

function cleanHeader(value, maxLength = 300) {
  return String(value || '').trim().slice(0, maxLength)
}

async function removeTempFile(req) {
  if (!req.file?.path) return
  await unlink(req.file.path).catch(() => {})
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

function rawUploadError(res, status, code, message, details = {}) {
  return res.status(status).json({
    ok: false,
    code,
    stage: 'receive',
    message,
    ...details,
  })
}

function stageRawImageFile(kind, maxBytes) {
  return async (req, res, next) => {
    const isNovel = kind === 'novel'
    const expectedBytes = Number(req.headers['content-length'] || 0)
    const tooLargeCode = isNovel
      ? 'NOVEL_IMAGE_TOO_LARGE'
      : 'MANGA_PAGE_TOO_LARGE'
    const tooLargeMessage = isNovel
      ? 'Novel image must be 5 MB or smaller.'
      : 'Manga page must be 5 MB or smaller.'

    if (expectedBytes > maxBytes) {
      return rawUploadError(
        res,
        413,
        tooLargeCode,
        tooLargeMessage,
        {
          expected_bytes: expectedBytes,
          max_bytes: maxBytes,
        }
      )
    }

    const tempPath = path.join(
      os.tmpdir(),
      `story-raw-${kind}-${Date.now()}-${randomUUID()}`
    )
    let receivedBytes = 0

    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length

        if (receivedBytes > maxBytes) {
          const error = new Error(tooLargeMessage)
          error.code = tooLargeCode
          error.statusCode = 413
          callback(error)
          return
        }

        callback(null, chunk)
      },
    })

    try {
      await pipeline(
        req,
        limiter,
        createWriteStream(tempPath, { flags: 'wx' })
      )

      if (receivedBytes === 0) {
        await unlink(tempPath).catch(() => {})

        return rawUploadError(
          res,
          400,
          'IMAGE_STREAM_EMPTY',
          'The browser reached the server but sent 0 image bytes. Please choose the image again and retry.',
          {
            received_bytes: 0,
            expected_bytes: expectedBytes,
            content_type: String(req.headers['content-type'] || ''),
          }
        )
      }

      if (
        expectedBytes > 0 &&
        receivedBytes !== expectedBytes
      ) {
        await unlink(tempPath).catch(() => {})

        return rawUploadError(
          res,
          400,
          'IMAGE_UPLOAD_SIZE_MISMATCH',
          'The image upload was incomplete because the received file size did not match the expected size. Please try again.',
          {
            received_bytes: receivedBytes,
            expected_bytes: expectedBytes,
          }
        )
      }

      req.file = {
        path: tempPath,
        size: receivedBytes,
        mimetype:
          cleanHeader(req.headers['content-type'], 120)
            .split(';')[0]
            .trim()
            .toLowerCase() ||
          'application/octet-stream',
        originalname:
          cleanHeader(req.headers['x-file-name'], 240) ||
          'episode-image',
      }

      return next()
    } catch (error) {
      await unlink(tempPath).catch(() => {})

      if (
        error?.code === tooLargeCode ||
        receivedBytes > maxBytes
      ) {
        return rawUploadError(
          res,
          413,
          tooLargeCode,
          tooLargeMessage,
          {
            received_bytes: receivedBytes,
            expected_bytes: expectedBytes,
            max_bytes: maxBytes,
          }
        )
      }

      return rawUploadError(
        res,
        400,
        req.aborted
          ? 'IMAGE_UPLOAD_INTERRUPTED'
          : 'IMAGE_STREAM_READ_FAILED',
        req.aborted
          ? 'The upload connection ended before the server received the complete image. Please check the connection and try again.'
          : 'The server could not read the incoming image stream. Please try again.',
        {
          received_bytes: receivedBytes,
          expected_bytes: expectedBytes,
        }
      )
    }
  }
}

function uploadStoryImageFile(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400

    return res.status(status).json({
      ok: false,
      code: error.code || 'UPLOAD_ERROR',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5 MB or smaller'
          : error.message || 'Invalid image upload',
    })
  })
}

router.post(
  '/upload-novel-image',
  requireUser,
  stageRawImageFile('novel', NOVEL_IMAGE_MAX_BYTES),
  cleanupTempFile,
  uploadNovelEpisodeImage
)

router.post(
  '/upload-manga-page',
  requireUser,
  guardMangaUploadMemory,
  stageRawImageFile('manga', MANGA_PAGE_MAX_BYTES),
  cleanupTempFile,
  uploadMangaPageImage
)

router.post(
  '/upload-manga-page-v2',
  requireUser,
  guardMangaTempUploadMemory,
  stageMangaV2UploadToR2,
  uploadMangaPageImageV2
)

router.get(
  '/manga-page-v2/jobs/:jobId',
  requireUser,
  getMangaPageImageV2JobStatus
)

router.post(
  '/cleanup-manga-page-v2',
  requireUser,
  cleanupTemporaryMangaPartsV2
)

router.post(
  '/upload-image',
  requireUser,
  uploadStoryImageFile,
  cleanupTempFile,
  uploadStoryImage
)

export default router
