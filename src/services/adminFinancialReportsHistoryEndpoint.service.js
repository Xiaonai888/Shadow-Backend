function safeError(error) {
  return String(error?.message || 'Unknown financial history error')
    .replace(/https?:\/\/\S+/gi, '[URL hidden]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [hidden]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)
}

export function createAdminFinancialReportsHistoryHandler({ db, loadHistory, clock = () => new Date(), logger = console } = {}) {
  if (!db || typeof db.from !== 'function') throw new TypeError('Financial history database is required')
  if (typeof loadHistory !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Financial history reader and clock are required')
  }

  return async function getFinancialHistoryRange(req, res) {
    try {
      const range = await loadHistory(db, { now: clock() })
      if (!range || range.ok !== true || !/^\d{4}-(0[1-9]|1[0-2])$/.test(range.start_month) ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(range.end_month) ||
        !Number.isInteger(range.months_total) || range.months_total < 1) {
        throw new Error('Invalid financial history range from source')
      }
      return res.status(200).json({
        ok: true,
        start_month: range.start_month,
        end_month: range.end_month,
        months_total: range.months_total,
        has_transactions: range.has_transactions === true,
        sync_mode: 'one_month_per_request',
      })
    } catch (error) {
      const detail = safeError(error)
      logger.error('ADMIN FINANCIAL REPORTS HISTORY RANGE ERROR:', detail)
      return res.status(502).json({
        ok: false,
        code: 'FINANCIAL_HISTORY_RANGE_FAILED',
        message: `Unable to determine the earliest financial transaction: ${detail}`,
      })
    }
  }
}
