import express from 'express'
import multer from 'multer'
import os from 'node:os'
import path from 'node:path'
import { unlink } from 'node:fs/promises'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createRateLimit as createIpLimiter,
  createRateLimit as createRateLimiter,
} from '../middleware/rateLimit.middleware.js'
import { uploadAuthorBookProof, viewBookShippingProof } from '../controllers/authorStoreBookProof.controller.js'

const router = express.Router()
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (req, file, done) => done(null, allowed.has(String(file.mimetype || '').toLowerCase())),
})
const writeIpLimit = createIpLimiter({ key: 'book-private-shipping-proof-write-ip', windowMs: 60 * 1000, max: 30 })
const readIpLimit = createIpLimiter({ key: 'book-private-shipping-proof-read-ip', windowMs: 60 * 1000, max: 90 })
const writeLimit = createRateLimiter({ key: 'book-private-shipping-proof', windowMs: 60 * 60 * 1000, max: 12, identity: (req) => req.user?.user_id })
const readLimit = createRateLimiter({ key: 'book-private-shipping-proof-read', windowMs: 60 * 1000, max: 60, identity: (req) => req.user?.user_id })

function uploadOne(req, res, next) {
  upload.single('proof')(req, res, (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, message: 'Invalid shipping proof image or file size' })
    if (!req.file) return res.status(400).json({ ok: false, message: 'JPEG, PNG or WebP shipping proof is required' })
    const filename = String(req.file.filename || '')
    let removed = false
    const cleanup = () => {
      if (removed) return
      removed = true
      if (!/^[0-9a-f]{32}$/i.test(filename)) return
      unlink(path.join(os.tmpdir(), filename)).catch(() => {})
    }
    res.once('finish', cleanup)
    res.once('close', cleanup)
    next()
  })
}

router.post('/book-holds/:holdId/proof-upload', writeIpLimit, requireUser, writeLimit, uploadOne, uploadAuthorBookProof)
router.get('/book-holds/:holdId/proofs/:proofId', readIpLimit, requireUser, readLimit, viewBookShippingProof)

export default router
