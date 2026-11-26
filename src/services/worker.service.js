import { sendPromotionPhoto } from './telegram.service.js'

const safeError = error => String(error?.message || error || 'UNKNOWN').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g, '[redacted]').slice(0, 300)

export function createPromotionWorker({ queue, candidates, token, send = sendPromotionPhoto, onError = () => {} }) {
  if (!queue?.claim || !candidates?.validate) throw new TypeError('Missing promotion worker dependencies')
  const notify = (code, job, error) => {
    try { onError({ code, job_id: job?.id || null, language: job?.language || null, message: safeError(error) }) } catch {}
  }
  const finish = async (job, outcome, options) => {
    if (!await queue.finish(job, outcome, options)) throw new Error('Promotion job lease lost')
    return { state: outcome, jobId: job.id }
  }
  return {
    async run(settings) {
      const secret = String(typeof token === 'function' ? token(settings?.language) : token || '').trim()
      if (!settings?.enabled || !settings.channel_id || !/^\d+:[A-Za-z0-9_-]+$/.test(secret)) return { state: 'disabled' }
      const job = await queue.claim(settings.language)
      if (!job) return { state: 'idle' }
      let fileId = null
      try {
        const decision = await candidates.validate(job)
        if (!decision.eligible) return await finish(job, 'cancelled', { error: decision.reason })
        try { fileId = await queue.getFileId(secret, job.payload.photo) } catch (error) { notify('PROMOTION_CACHE_READ_FAILED', job, error) }
      } catch (error) {
        notify('PROMOTION_VALIDATE_FAILED', job, error)
        return await finish(job, 'retry', { error: safeError(error), retrySeconds: 300 })
      }
      let sent
      try {
        try {
          sent = await send({ token: secret, chatId: job.telegram_chat_id, message: job.payload, fileId })
        } catch (error) {
          if (!fileId || error.status !== 400 || error.uncertain) throw error
          try { await queue.removeFileId(secret, job.payload.photo) } catch (cacheError) { notify('PROMOTION_CACHE_REMOVE_FAILED', job, cacheError) }
          sent = await send({ token: secret, chatId: job.telegram_chat_id, message: job.payload, fileId: null })
        }
      } catch (error) {
        notify('PROMOTION_SEND_FAILED', job, error)
        if (error.uncertain || !error.status || error.status >= 500) return await finish(job, 'uncertain', { error: safeError(error) })
        if (error.status === 429) return await finish(job, 'retry', { error: safeError(error), retrySeconds: Math.max(60, Math.min(2147483647, Math.ceil(error.retryAfter || 300))) })
        return await finish(job, 'failed', { error: safeError(error) })
      }
      const outcome = await finish(job, 'sent', { messageId: sent.messageId })
      if (sent.fileId) {
        try { await queue.saveFileId(secret, job.payload.photo, sent.fileId) } catch (error) { notify('PROMOTION_CACHE_WRITE_FAILED', job, error) }
      }
      return outcome
    },
  }
}
