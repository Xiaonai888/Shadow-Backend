import express from 'express'
import { getContentVersions } from '../services/contentVersion.service.js'

const router = express.Router()

function parseKeys(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

async function handleGetContentVersions(req, res) {
  try {
    const keys = parseKeys(req.query.keys)
    const versions = await getContentVersions(keys.length ? keys : undefined)

    return res.status(200).json({
      ok: true,
      versions,
    })
  } catch (error) {
    console.error('PUBLIC CONTENT VERSIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load content versions',
    })
  }
}

router.get('/content-versions', handleGetContentVersions)
router.get('/versions', handleGetContentVersions)
router.get('/version', handleGetContentVersions)

export default router
