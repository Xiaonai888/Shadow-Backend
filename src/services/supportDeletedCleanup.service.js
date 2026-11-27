import { validateSupportImageKey } from './supportChatImageInput.service.js'

const DAY_MS = 86400000
const START_DELAY_MS = 120000
let started = false
let running = false

export async function runSupportDeletedCleanup({ db, deleteImage }) {
  if (running) return { skipped: true }
  running = true
  try {
    const { data: counts, error: cleanupError } = await db.rpc('cleanup_deleted_support_content_v1', { p_limit: 100 })
    if (cleanupError) throw cleanupError
    if (!counts || !['migrated', 'expired'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 100)) throw new Error('Invalid support retention cleanup result')
    const { data: rows, error: claimError } = await db.rpc('claim_deleted_support_media_v1', { p_limit: 20 })
    if (claimError) throw claimError
    if (!Array.isArray(rows) || rows.length > 20) throw new Error('Invalid support media cleanup result')
    let removed = 0
    let failed = 0
    for (const { storage_key: key } of rows) {
      if (!validateSupportImageKey(key, 'media')) { failed++; continue }
      try {
        await deleteImage(key, 'media')
        const { error } = await db.from('admin_support_deleted_media_queue').delete().eq('storage_key', key)
        if (error) throw error
        removed++
      } catch { failed++ }
    }
    return { migrated: counts.migrated, expired: counts.expired, removed, failed }
  } finally {
    running = false
  }
}

export function startSupportDeletedCleanup({ db, deleteImage, enabled = true, logger = console }) {
  if (started || !enabled) return false
  started = true
  const schedule = delay => {
    const timer = setTimeout(async () => {
      try {
        const result = await runSupportDeletedCleanup({ db, deleteImage })
        if (result.failed) logger.warn('SUPPORT_DELETED_MEDIA_CLEANUP_FAILED', result.failed)
      } catch {
        logger.error('SUPPORT_DELETED_CONTENT_CLEANUP_FAILED')
      } finally {
        schedule(DAY_MS)
      }
    }, delay)
    timer.unref?.()
  }
  schedule(START_DELAY_MS)
  return true
}
