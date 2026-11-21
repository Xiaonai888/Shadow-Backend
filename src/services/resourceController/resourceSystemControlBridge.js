import { getResourceTelemetrySnapshot } from './resourceTelemetry.js'
import { listResourcePolicies } from './resourcePolicies.js'
import { readResourceRuntimeEvidence } from './resourceRuntimeEvidence.js'
import { getResourceJobEvidenceSnapshot } from './resourceJobEvidence.js'
import { getResourceConditionsSnapshot } from './resourceIncidentLedger.js'

export function getResourceSystemControlSnapshot({
  jobType = 'manga_page_v2',
  eventLimit = 30,
  conditionLimit = 20,
} = {}) {
  const runtime = readResourceRuntimeEvidence({ jobType })
  const memory = runtime.memory
  const admissionDenied = runtime.available && memory?.admissionAllowed === false
  const reason = admissionDenied ? memory.admissionReason : null
  const blocker = !runtime.available
    ? 'RUNTIME_EVIDENCE_UNAVAILABLE'
    : admissionDenied
      ? 'MEMORY_ADMISSION_DENIED'
      : runtime.worker?.enabled === false
        ? 'WORKER_DISABLED'
        : runtime.worker?.available === false
          ? 'WORKER_STATE_UNAVAILABLE'
          : null

  return {
    generatedAt: new Date().toISOString(),
    mode: 'passive_read_only_until_integrated',
    status: blocker ? 'attention' : 'observed',
    check: {
      jobType: String(jobType),
      blocker,
      reason,
      confirmedByRuntime: Boolean(admissionDenied),
      jobFailureConfirmed: false,
      source: runtime.source,
    },
    runtime,
    telemetry: getResourceTelemetrySnapshot({ eventLimit }),
    jobEvidence: getResourceJobEvidenceSnapshot({ limit: eventLimit }),
    conditions: getResourceConditionsSnapshot({ limit: conditionLimit }),
    policies: listResourcePolicies(),
    coverage: {
      runtime: runtime.available,
      controllerLifecycleConnected: false,
      workerEventsConnected: false,
      adminEndpointConnected: false,
      persistentIncidentStorageConnected: false,
    },
  }
}
