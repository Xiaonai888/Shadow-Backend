import { supabase } from '../config/supabase.js'
import {
  connectAdminFinancialReports,
  isAdminFinancialReportsConfigured,
  upsertAdminFinancialReportRows,
} from '../services/adminFinancialReportsGoogle.service.js'
import { loadAdminFinancialReportSourceRows } from '../services/adminFinancialReportsSources.service.js'
import { createAdminFinancialReportsSyncService } from '../services/adminFinancialReportsSync.service.js'
import {
  adminFinancialConfiguredSheetUrl,
  validateAdminFinancialSheetLink,
} from '../services/adminFinancialReportsSheetLink.service.js'
import { diagnoseAdminFinancialReportsError } from '../services/adminFinancialReportsDiagnostics.service.js'

const reports = createAdminFinancialReportsSyncService({
  isConfigured: isAdminFinancialReportsConfigured,
  connect: connectAdminFinancialReports,
  writeRows: upsertAdminFinancialReportRows,
  loadRows: (period) => loadAdminFinancialReportSourceRows({ db: supabase, ...period }),
})

function errorReply(res, error, task, spreadsheetUrl = '') {
  const result = diagnoseAdminFinancialReportsError(error, {
    task,
    spreadsheetUrl,
    spreadsheetId: process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID,
    secret: process.env.SHADOW_ADMIN_FINANCIAL_SECRET,
  })
  console.error(`ADMIN FINANCIAL REPORTS ${task} ERROR:`, result.diagnostic.code, result.diagnostic.origin)
  return res.status(result.statusCode).json({
    ok: false,
    code: result.diagnostic.code,
    message: result.message,
    diagnostic: result.diagnostic,
    ...(Number.isInteger(error?.synced_rows) ? { synced_rows: error.synced_rows } : {}),
  })
}

export function getAdminFinancialReportsStatus(req, res) {
  const current = reports.status()
  return res.status(200).json({
    ok: true,
    ...current,
    spreadsheet_url: current.configured
      ? adminFinancialConfiguredSheetUrl(process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID)
      : '',
  })
}

export async function connectAdminFinancialReportsSheet(req, res) {
  try {
    validateAdminFinancialSheetLink(
      req.body?.spreadsheet_url,
      process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID
    )
    const result = await reports.connectSheet()
    return res.status(200).json(result)
  } catch (error) {
    return errorReply(res, error, 'CONNECT', req.body?.spreadsheet_url)
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
