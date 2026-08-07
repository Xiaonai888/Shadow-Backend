import { supabase } from '../config/supabase.js'

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const CLEANUP_START_DELAY_MS = 2 * 60 * 1000

let cleanupStarted = false
let cleanupRunning = false

async function writeSystemLog(result) {
  try {
    await supabase.from('chat_admin_access_logs').insert({
      admin_id: 'system:retention-cleanup',
      admin_role: 'system',
      conversation_id: null,
      message_id: null,
      action: 'scheduled_retention_purge',
      reason: 'Automatic 90-day chat evidence cleanup',
      ip_address: null,
      user_agent: null,
      metadata: { result },
    })
  } catch (error) {
    console.warn('CHAT RETENTION CLEANUP LOG WARNING:', error?.message || error)
  }
}

export async function runChatRetentionCleanup() {
  if (cleanupRunning) {
    return { ok: true, skipped: true }
  }

  cleanupRunning = true

  try {
    const { data, error } = await supabase.rpc('purge_expired_chat_data')

    if (error) throw error

    const result = {
      ok: true,
      ...(data || {}),
    }

    await writeSystemLog(result)
    return result
  } catch (error) {
    console.error('CHAT RETENTION CLEANUP ERROR:', error)

    return {
      ok: false,
      error: String(error?.message || error || 'Cleanup failed').slice(0, 500),
    }
  } finally {
    cleanupRunning = false
  }
}

export function startChatRetentionCleanup() {
  if (
    cleanupStarted ||
    process.env.ENABLE_CHAT_RETENTION_CLEANUP === 'false'
  ) {
    return
  }

  cleanupStarted = true

  const startTimer = setTimeout(() => {
    runChatRetentionCleanup()
  }, CLEANUP_START_DELAY_MS)

  const interval = setInterval(() => {
    runChatRetentionCleanup()
  }, CLEANUP_INTERVAL_MS)

  startTimer.unref?.()
  interval.unref?.()
}
