import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  claimNextHeavyMediaJob,
  failHeavyMediaJob,
  getHeavyMediaJob,
} from './heavyMediaJob.service.js'
import {
  evaluateHeavyJobAdmission,
  getMemoryGuardSnapshot,
} from './memoryGuard.service.js'

const POLL_INTERVAL_MS = 2000
const WORKER_LEASE_SECONDS = 900
const WORKER_TIMEOUT_MS = 12 * 60 * 1000
const WORKER_KILL_GRACE_MS = 5000
const JOB_TYPES = ['manga_page_v2']
const WORKER_FILE = fileURLToPath(
  new URL(
    '../workers/mangaProcessing.worker.js',
    import.meta.url
  )
)

let coordinatorStarted = false
let cycleRunning = false
let activeWorker = null
let pollTimer = null

function enabled() {
  return String(
    process.env.HEAVY_MEDIA_WORKER_ENABLED ??
    'true'
  )
    .trim()
    .toLowerCase() !== 'false'
}

function scheduleNext(
  delayMs = POLL_INTERVAL_MS
) {
  if (
    !coordinatorStarted ||
    !enabled()
  ) {
    return
  }

  if (pollTimer) {
    clearTimeout(pollTimer)
  }

  pollTimer = setTimeout(() => {
    pollTimer = null
    void runCoordinatorCycle()
  }, Math.max(0, Number(delayMs) || 0))

  pollTimer.unref?.()
}

function workerIdForJob() {
  return [
    'manga-v2-worker',
    process.pid,
    randomUUID(),
  ].join(':')
}

async function markAbnormalWorkerFailure(
  jobId,
  workerId,
  reason
) {
  try {
    const job = await getHeavyMediaJob({
      jobId,
    })

    if (
      !job ||
      job.status !== 'processing' ||
      job.worker_id !== workerId
    ) {
      return
    }

    await failHeavyMediaJob({
      jobId,
      workerId,
      errorCode:
        'MANGA_WORKER_EXITED',
      errorMessage: reason,
      retry: true,
      retryDelaySeconds: 30,
    })
  } catch (error) {
    console.error(
      'HEAVY_MEDIA_WORKER_FAILURE_SYNC_ERROR:',
      error
    )
  }
}

function terminateWorkerForMemory(
  job,
  child,
  state
) {
  if (
    !activeWorker ||
    activeWorker.emergencyStopping
  ) {
    return
  }

  activeWorker.emergencyStopping = true

  console.error(
    'MEMORY_CRITICAL:',
    JSON.stringify({
      job_id: job.id,
      job_type: job.job_type,
      action: 'terminate_worker',
      parent_rss_mb: state.rss_mb,
      container_total_mb:
        state.container_total_mb,
      container_limit_mb:
        state.container_limit_mb,
      usage_percent:
        state.usage_percent,
    })
  )

  child.kill('SIGTERM')
}

function startClaimedWorker(
  job,
  workerId
) {
  let settled = false
  let timedOut = false
  let killTimer = null
  const startedAt = Date.now()

  let child

  try {
    child = fork(
      WORKER_FILE,
      [job.id, workerId],
      {
        env: process.env,
        stdio: [
          'ignore',
          'inherit',
          'inherit',
          'ipc',
        ],
      }
    )
  } catch (error) {
    void markAbnormalWorkerFailure(
      job.id,
      workerId,
      String(
        error?.message ||
        'Worker could not start.'
      )
    )
    throw error
  }

  activeWorker = {
    child,
    jobId: job.id,
    workerId,
    startedAt,
    emergencyStopping: false,
  }

  const startMemory =
    getMemoryGuardSnapshot()

  console.log(
    'MEMORY_JOB_START:',
    JSON.stringify({
      job_id: job.id,
      job_type: job.job_type,
      worker_id: workerId,
      parent_rss_mb:
        startMemory.rss_mb,
      container_total_mb:
        startMemory.container_total_mb,
      container_limit_mb:
        startMemory.container_limit_mb,
    })
  )

  const timeoutTimer = setTimeout(() => {
    timedOut = true

    console.error(
      'MEMORY_WORKER_LIMIT:',
      JSON.stringify({
        job_id: job.id,
        job_type: job.job_type,
        reason: 'worker_timeout',
        timeout_ms:
          WORKER_TIMEOUT_MS,
      })
    )

    child.kill('SIGTERM')

    killTimer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
      }
    }, WORKER_KILL_GRACE_MS)

    killTimer.unref?.()
  }, WORKER_TIMEOUT_MS)

  timeoutTimer.unref?.()

  child.on('message', (message) => {
    if (
      !message ||
      typeof message !== 'object'
    ) {
      return
    }

    const memory =
      getMemoryGuardSnapshot()

    if (
      memory.emergency &&
      !activeWorker?.emergencyStopping
    ) {
      terminateWorkerForMemory(
        job,
        child,
        memory
      )
    }

    if (message.type === 'memory') {
      console.log(
        'MEMORY_JOB_SAMPLE:',
        JSON.stringify({
          job_id: job.id,
          job_type: job.job_type,
          worker_rss_mb:
            message.rss_mb,
          worker_peak_rss_mb:
            message.peak_rss_mb,
          parent_rss_mb:
            memory.rss_mb,
          container_total_mb:
            memory.container_total_mb,
          container_limit_mb:
            memory.container_limit_mb,
          usage_percent:
            memory.usage_percent,
        })
      )
      return
    }

    if (
      message.type === 'done' ||
      message.type === 'failed'
    ) {
      console.log(
        'MEMORY_JOB_RESULT:',
        JSON.stringify({
          job_id: job.id,
          job_type: job.job_type,
          result: message.type,
          status:
            message.status || null,
          worker_peak_rss_mb:
            message.peak_rss_mb ||
            null,
          container_total_mb:
            memory.container_total_mb,
        })
      )
    }
  })

  child.once(
    'error',
    async (error) => {
      console.error(
        'HEAVY_MEDIA_WORKER_PROCESS_ERROR:',
        error
      )

      await markAbnormalWorkerFailure(
        job.id,
        workerId,
        String(
          error?.message ||
          'Worker process error.'
        )
      )
    }
  )

  child.once(
    'exit',
    async (code, signal) => {
      settled = true
      clearTimeout(timeoutTimer)

      if (killTimer) {
        clearTimeout(killTimer)
      }

      const endMemory =
        getMemoryGuardSnapshot()
      const emergencyStopped =
        Boolean(
          activeWorker?.emergencyStopping
        )

      console.log(
        'MEMORY_JOB_END:',
        JSON.stringify({
          job_id: job.id,
          job_type: job.job_type,
          worker_id: workerId,
          exit_code: code,
          signal: signal || null,
          timed_out: timedOut,
          emergency_stopped:
            emergencyStopped,
          duration_ms:
            Date.now() - startedAt,
          parent_rss_mb:
            endMemory.rss_mb,
          container_total_mb:
            endMemory.container_total_mb,
        })
      )

      if (
        timedOut ||
        emergencyStopped ||
        code !== 0
      ) {
        await markAbnormalWorkerFailure(
          job.id,
          workerId,
          timedOut
            ? 'Manga worker exceeded its time limit.'
            : emergencyStopped
              ? 'Manga worker was stopped to protect server memory.'
              : `Manga worker exited with code ${code} and signal ${signal || 'none'}.`
        )
      }

      activeWorker = null
      scheduleNext(250)
    }
  )
}

async function runCoordinatorCycle() {
  if (
    !coordinatorStarted ||
    !enabled() ||
    cycleRunning ||
    activeWorker
  ) {
    return
  }

  cycleRunning = true

  try {
    const admission =
      evaluateHeavyJobAdmission({
        jobType: 'manga_page_v2',
      })

    if (!admission.allowed) {
      console.warn(
        'MEMORY_GUARD_WAIT:',
        JSON.stringify({
          kind:
            'heavy_media_worker',
          reason:
            admission.reason,
          parent_rss_mb:
            admission.rss_mb,
          container_total_mb:
            admission.container_total_mb,
          container_limit_mb:
            admission.container_limit_mb,
          estimated_job_mb:
            admission.estimated_job_mb,
          safety_reserve_mb:
            admission.safety_reserve_mb,
          projected_mb:
            admission.projected_mb,
        })
      )
      return
    }

    const workerId =
      workerIdForJob()
    const job =
      await claimNextHeavyMediaJob({
        workerId,
        leaseSeconds:
          WORKER_LEASE_SECONDS,
        jobTypes: JOB_TYPES,
      })

    if (!job) return

    startClaimedWorker(
      job,
      workerId
    )
  } catch (error) {
    console.error(
      'HEAVY_MEDIA_COORDINATOR_ERROR:',
      error
    )
  } finally {
    cycleRunning = false

    if (!activeWorker) {
      scheduleNext()
    }
  }
}

export function wakeHeavyMediaWorkerCoordinator() {
  if (
    !coordinatorStarted ||
    !enabled()
  ) {
    return false
  }

  scheduleNext(0)
  return true
}

export function startHeavyMediaWorkerCoordinator() {
  if (coordinatorStarted) {
    return false
  }

  coordinatorStarted = true

  if (!enabled()) {
    console.log(
      'HEAVY_MEDIA_WORKER_COORDINATOR: disabled'
    )
    return false
  }

  console.log(
    'HEAVY_MEDIA_WORKER_COORDINATOR: started'
  )

  scheduleNext(1000)
  return true
}
