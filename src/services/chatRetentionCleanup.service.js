import { supabase } from '../config/supabase.js'

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const CLEANUP_START_DELAY_MS = 2 * 60 * 1000
const AUTO_DELETE_INTERVAL_MS = 60 * 1000
const AUTO_DELETE_START_DELAY_MS = 10 * 1000

let cleanupStarted = false
let cleanupRunning = false
let autoDeleteRunning = false

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
    console.warn(
      'CHAT RETENTION CLEANUP LOG WARNING:',
      error?.message || error
    )
  }
}

async function writeAutoDeleteLog(result) {
  if (
    Number(result?.expired_messages || 0) <= 0
  ) {
    return
  }

  try {
    await supabase.from('chat_admin_access_logs').insert({
      admin_id: 'system:auto-delete',
      admin_role: 'system',
      conversation_id: null,
      message_id: null,
      action: 'scheduled_chat_auto_delete',
      reason: 'Automatic chat message expiration',
      ip_address: null,
      user_agent: null,
      metadata: { result },
    })
  } catch (error) {
    console.warn(
      'CHAT AUTO DELETE LOG WARNING:',
      error?.message || error
    )
  }
}

export async function runChatRetentionCleanup() {
  if (cleanupRunning) {
    return { ok: true, skipped: true }
  }

  cleanupRunning = true

  try {
    const { data, error } = await supabase.rpc(
      'purge_expired_chat_data'
    )

    if (error) throw error

    const result = {
      ok: true,
      ...(data || {}),
    }

    await writeSystemLog(result)
    return result
  } catch (error) {
    console.error(
      'CHAT RETENTION CLEANUP ERROR:',
      error
    )

    return {
      ok: false,
      error: String(
        error?.message ||
        error ||
        'Cleanup failed'
      ).slice(0, 500),
    }
  } finally {
    cleanupRunning = false
  }
}

export async function runChatAutoDeleteCleanup() {
  if (autoDeleteRunning) {
    return { ok: true, skipped: true }
  }

  autoDeleteRunning = true

  try {
    const { data, error } = await supabase.rpc(
      'expire_due_chat_messages'
    )

    if (error) throw error

    const result = {
      ok: true,
      ...(data || {}),
    }

    await writeAutoDeleteLog(result)
    return result
  } catch (error) {
    console.error(
      'CHAT AUTO DELETE CLEANUP ERROR:',
      error
    )

    return {
      ok: false,
      error: String(
        error?.message ||
        error ||
        'Auto-delete cleanup failed'
      ).slice(0, 500),
    }
  } finally {
    autoDeleteRunning = false
  }
}

export function startChatRetentionCleanup() {
  if (cleanupStarted) {
    return
  }

  cleanupStarted = true

  const retentionEnabled =
    process.env.ENABLE_CHAT_RETENTION_CLEANUP !==
    'false'
  const autoDeleteEnabled =
    process.env.ENABLE_CHAT_AUTO_DELETE_CLEANUP !==
    'false'

  if (retentionEnabled) {
    const startTimer = setTimeout(() => {
      runChatRetentionCleanup()
    }, CLEANUP_START_DELAY_MS)

    const interval = setInterval(() => {
      runChatRetentionCleanup()
    }, CLEANUP_INTERVAL_MS)

    startTimer.unref?.()
    interval.unref?.()
  }

  if (autoDeleteEnabled) {
    const autoDeleteStartTimer = setTimeout(() => {
      runChatAutoDeleteCleanup()
    }, AUTO_DELETE_START_DELAY_MS)

    const autoDeleteInterval = setInterval(() => {
      runChatAutoDeleteCleanup()
    }, AUTO_DELETE_INTERVAL_MS)

    autoDeleteStartTimer.unref?.()
    autoDeleteInterval.unref?.()
  }
}
