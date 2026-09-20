import { supabase } from '../config/supabase.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const CLEANUP_START_DELAY_MS = 3 * 60 * 1000
const BATCH_SIZE = 200
const MAX_BATCHES_PER_RUN = 5

let started = false
let running = false

export async function runReaderLibraryTrashCleanup() {
  if (running) return
  running = true

  try {
    const cutoff = new Date().toISOString()
    let deletedCount = 0

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const { data: expired, error: readError } = await supabase
        .from('reader_library_trash')
        .select('id')
        .lte('expires_at', cutoff)
        .order('expires_at', { ascending: true })
        .limit(BATCH_SIZE)

      if (readError) throw readError
      if (!expired?.length) break

      const ids = expired.map(({ id }) => id)
      const { data: removed, error: deleteError } = await supabase
        .from('reader_library_trash')
        .delete()
        .in('id', ids)
        .lte('expires_at', cutoff)
        .select('id')

      if (deleteError) throw deleteError
      deletedCount += removed?.length || 0
      if (expired.length < BATCH_SIZE) break
    }

    if (deletedCount > 0) console.log(`READER LIBRARY TRASH CLEANUP: ${deletedCount}`)
  } catch (error) {
    console.error('READER LIBRARY TRASH CLEANUP ERROR:', error)
  } finally {
    running = false
  }
}

export function startReaderLibraryTrashCleanup() {
  if (started) return
  started = true

  const startTimer = setTimeout(() => { void runReaderLibraryTrashCleanup() }, CLEANUP_START_DELAY_MS)
  const interval = setInterval(() => { void runReaderLibraryTrashCleanup() }, CLEANUP_INTERVAL_MS)
  startTimer.unref?.()
  interval.unref?.()
}
