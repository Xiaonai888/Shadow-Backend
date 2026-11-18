import { supabase } from '../config/supabase.js'
import { verifySystemUsageGroupArchive } from './systemUsageGroupedArchive.service.js'

export const SYSTEM_USAGE_ARCHIVE_BUCKET = 'shadow-system-usage-archives'

function validatePath(path) {
  if (typeof path !== 'string' || !/^v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.json\.gz$/.test(path)) {
    throw new TypeError('Invalid system usage archive object path.')
  }
  return path
}

export async function readSystemUsageArchiveObject({ path, manifest, client = supabase }) {
  validatePath(path)
  const { data, error } = await client.storage.from(SYSTEM_USAGE_ARCHIVE_BUCKET).download(path)
  if (error) throw new Error('System usage archive object is unavailable.', { cause: error })
  if (!data || typeof data.arrayBuffer !== 'function') {
    throw new TypeError('System usage archive download returned invalid data.')
  }
  const archive = Buffer.from(await data.arrayBuffer())
  const recovered = verifySystemUsageGroupArchive(archive, manifest)
  return { archive, recovered }
}

export async function writeSystemUsageArchiveObject({ path, archive, manifest, client = supabase }) {
  validatePath(path)
  if (!Buffer.isBuffer(archive)) throw new TypeError('System usage archive must be a Buffer.')
  verifySystemUsageGroupArchive(archive, manifest)

  const { error } = await client.storage.from(SYSTEM_USAGE_ARCHIVE_BUCKET).upload(path, archive, {
    contentType: 'application/gzip',
    cacheControl: '31536000',
    upsert: false,
  })

  try {
    await readSystemUsageArchiveObject({ path, manifest, client })
  } catch (verificationError) {
    if (error) throw new Error('System usage archive upload failed and could not be verified.', { cause: error })
    throw verificationError
  }

  return { bucket: SYSTEM_USAGE_ARCHIVE_BUCKET, path, verified: true }
}
