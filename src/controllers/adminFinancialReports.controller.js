import { supabase } from '../config/supabase.js'
import {
  connectAdminFinancialReports,
  isAdminFinancialReportsConfigured,
  upsertAdminFinancialReportRows,
} from '../services/adminFinancialReportsGoogle.service.js'
import { loadAdminFinancialReportSourceRows } from '../services/adminFinancialReportsSources.service.js'
import { createAdminFinancialReportsSyncService } from '../services/adminFinancialReportsSync.service.js'

const reports = createAdminFinancialReportsSyncService({
  isConfigured: isAdminFinancialReportsConfigured,
  connect: connectAdminFinancialReports,
  writeRows: upsertAdminFinancialReportRows,
  loadRows: (period) => loadAdminFinancialReportSourceRows({ db: supabase, ...period }),
})

function errorReply(res, error, task) {
  const status = Number(error?.statusCode)
  const safeStatus = [400, 409, 413, 429, 503].includes(status) ? status : 502
  if (safeStatus === 502) console.error(`ADMIN FINANCIAL REPORTS ${task} ERROR:`, error)
  return res.status(safeStatus).json({
    ok: false,
    message: safeStatus === 502
      ? 'Unable to complete Financial Reports request; check server logs'
      : String(error.message || 'Financial Reports request failed').slice(0, 180),
    ...(Number.isInteger(error?.synced_rows) ? { synced_rows: error.synced_rows } : {}),
  })
}

export function getAdminFinancialReportsStatus(req, res) {
  return res.status(200).json({ ok: true, ...reports.status() })
}

export async function connectAdminFinancialReportsSheet(req, res) {
  try {
    const result = await reports.connectSheet()
    return res.status(200).json(result)
  } catch (error) {
    return errorReply(res, error, 'CONNECT')
  }
}

export async function syncAdminFinancialReportsSheet(req, res) {
  try {
    const period = {
      month: req.body?.month,
      from: req.body?.from,
      to: req.body?.to,
    }
    const result = await reports.syncPeriod(period)
    return res.status(200).json(result)
  } catch (error) {
    return errorReply(res, error, 'SYNC')
  }
}
