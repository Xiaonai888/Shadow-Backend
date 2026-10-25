import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { uploadAuthorBookProof, viewBookShippingProof } from '../controllers/authorStoreBookProof.controller.js'

const router = express.Router()
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (req, file, done) => done(null, allowed.has(String(file.mimetype || '').toLowerCase())),
})
const writeLimit = createRateLimit({ key: 'book-private-shipping-proof', windowMs: 60 * 60 * 1000, max: 12, identity: (req) => req.user?.user_id })

function uploadOne(req, res, next) {
  upload.single('proof')(req, res, (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, message: 'Invalid shipping proof image or file size' })
    if (!req.file) return res.status(400).json({ ok: false, message: 'JPEG, PNG or WebP shipping proof is required' })
    let removed = false
    const cleanup = () => {
      if (removed) return
      removed = true
      unlink(req.file.path).catch(() => {})
    }
    res.once('finish', cleanup)
    res.once('close', cleanup)
    next()
  })
}

router.use(requireUser)
router.post('/book-holds/:holdId/proof-upload', writeLimit, uploadOne, uploadAuthorBookProof)
router.get('/book-holds/:holdId/proofs/:proofId', viewBookShippingProof)

export default router
