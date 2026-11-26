import { getResourceOptimizationEvidenceSnapshot } from './resourceOptimizationEvidence.service.js'
import { buildResourceOptimizationAdvisor } from './resourceOptimizationAdvisor.service.js'

export function getResourceOptimizationSnapshot(options = {}) {
  const evidence = getResourceOptimizationEvidenceSnapshot(options)
  return { generated_at: new Date(Number.isFinite(options.now) ? options.now : Date.now()).toISOString(), evidence, advisor: buildResourceOptimizationAdvisor(evidence) }
}
