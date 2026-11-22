import { AUTHOR_PREORDER_RECON_OPS_HEALTH_CACHE_MS } from './authorPreOrderReconciliationOpsPolicy.service.js'
import { getAuthorPreOrderReconciliationOpsManualState } from './authorPreOrderReconciliationOpsManual.service.js'
import { inspectAuthorPreOrderReconciliationOpsHealth } from './authorPreOrderReconciliationOpsHealth.service.js'

let cachedAt = 0
let cached = null
let inFlight = null

export async function inspectAuthorPreOrderReconciliationOps({ includeCounts = true } = {}) {
  const manual = getAuthorPreOrderReconciliationOpsManualState()
  if (!includeCounts) return { manual, health: null, health_read_only: true }
  const now = Date.now()
  if (cached && now - cachedAt < AUTHOR_PREORDER_RECON_OPS_HEALTH_CACHE_MS) {
    return { manual, health: cached, health_read_only: true, cached: true }
  }
  if (!inFlight) {
    inFlight = inspectAuthorPreOrderReconciliationOpsHealth()
      .then(result => {
        cached = result
        cachedAt = Date.now()
        return result
      })
      .finally(() => { inFlight = null })
  }
  const health = await inFlight
  return { manual, health, health_read_only: true, cached: false }
}
