import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getContentVersions } from '../services/contentVersion.service.js'

const router = express.Router()

const contentVersionsReadLimit =
  createRateLimit({
    key: 'public-content-versions',
    windowMs: 60 * 1000,
    max: 1500,
    message:
      'Too many requests. Please wait before trying again.',
  })

function parseKeys(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

async function handleGetContentVersions(
  req,
  res
) {
  try {
    const keys =
      parseKeys(req.query.keys)

    const versions =
      await getContentVersions(
        keys.length
          ? keys
          : undefined
      )

    return res.status(200).json({
      ok: true,
      versions,
    })
  } catch (error) {
    console.error(
      'PUBLIC CONTENT VERSIONS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load content versions',
    })
  }
}

router.get(
  '/content-versions',
  contentVersionsReadLimit,
  handleGetContentVersions
)
router.get(
  '/versions',
  contentVersionsReadLimit,
  handleGetContentVersions
)
router.get(
  '/version',
  contentVersionsReadLimit,
  handleGetContentVersions
)

export default router
