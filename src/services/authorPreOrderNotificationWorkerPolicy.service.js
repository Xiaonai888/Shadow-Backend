import { preOrderError } from './authorPreOrderValidation.service.js'

export const AUTHOR_PREORDER_NOTIFY_INTERVAL_MS = 60_000
export const AUTHOR_PREORDER_NOTIFY_ERROR_INTERVAL_MS = 300_000
export const AUTHOR_PREORDER_NOTIFY_BATCH_LIMIT = 5

export function authorPreOrderNotificationWorkerEnabled() {
  return String(process.env.AUTHOR_PREORDER_NOTIFICATION_WORKER_ENABLED || '')
    .trim().toLowerCase() === 'true'
}

export function validateAuthorPreOrderNotificationBatchLimit(limit = AUTHOR_PREORDER_NOTIFY_BATCH_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_INVALID_LIMIT', 'Worker batch size must be between 1 and 10', 400)
  }
  return limit
}

export function assessAuthorPreOrderNotificationWorkerHealth(health, { now = Date.now() } = {}) {
  const queued = Number(health?.queued)
  const retrying = Number(health?.retrying)
  const exhausted = Number(health?.exhausted)
  const processing = Number(health?.processing)
  const sent = Number(health?.sent)
  const ready = Number(health?.ready)
  if (![queued, retrying, exhausted, processing, sent, ready].every(value =>
    Number.isSafeInteger(value) && value >= 0
  ) || ready > queued + retrying) {
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_HEALTH_INVALID', 'Notification worker health data is invalid', 503)
  }
  const oldestRaw = health?.oldest_pending_at ?? null
  const oldestMs = oldestRaw === null ? null : Date.parse(String(oldestRaw))
  if ((oldestRaw !== null && !Number.isFinite(oldestMs)) || !Number.isFinite(now)) {
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_HEALTH_INVALID', 'Notification worker health timestamp is invalid', 503)
  }
  const oldestMinutes = oldestMs === null ? null : Math.max(0, Math.floor((now - oldestMs) / 60_000))
  return {
    queued, retrying, exhausted, processing, sent, ready,
    oldest_pending_at: oldestRaw,
    oldest_pending_minutes: oldestMinutes,
    needs_attention: exhausted > 0 || processing > 0 || (oldestMinutes !== null && oldestMinutes > 30),
  }
}
