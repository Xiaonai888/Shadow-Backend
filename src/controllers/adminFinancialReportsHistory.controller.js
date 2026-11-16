import { supabase } from '../config/supabase.js'
import { getAdminFinancialHistoryRange } from '../services/adminFinancialReportsHistory.service.js'
import { createAdminFinancialReportsHistoryHandler } from '../services/adminFinancialReportsHistoryEndpoint.service.js'

export const getAdminFinancialReportsHistoryRange = createAdminFinancialReportsHistoryHandler({
  db: supabase,
  loadHistory: getAdminFinancialHistoryRange,
})
