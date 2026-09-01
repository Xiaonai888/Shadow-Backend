import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  claimNextHeavyMediaJob,
  failHeavyMediaJob,
  getHeavyMediaJob,
} from './heavyMediaJob.service.js'
import {
  getMemoryGuardSnapshot,
} from './memoryGuard.service.js'

const POLL_INTERVAL_MS = 2000
const START_RSS_LIMIT_MB = 300
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
    process.env.HEAVY_MEDIA_WORKER_ENABLED ?? 'true'
  )
    .trim()
    .toLowerCase() !== 'false'
}

function scheduleNext(delayMs = POLL_INTERVAL_MS) {
  if (!coordinatorStarted || !enabled()) return

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
    const job = await getHeavyMediaJob({ jobId })

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
      errorCode: 'MANGA_WORKER_EXITED',
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

function startClaimedWorker(job, workerId) {
  let settled = false
  let timedOut = false
  let killTimer = null
  const startedAt = Date.now()

  const child = fork(
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

  activeWorker = {
    child,
    jobId: job.id,
    workerId,
    startedAt,
  }

  console.log(
    'MEMORY_JOB_START:',
    JSON.stringify({
      job_id: job.id,
      job_type: job.job_type,
      worker_id: workerId,
      parent_rss_mb:
        getMemoryGuardSnapshot().rss_mb,
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
        timeout_ms: WORKER_TIMEOUT_MS,
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
    if (!message || typeof message !== 'object') {
      return
    }

    if (message.type === 'memory') {
      console.log(
        'MEMORY_JOB_SAMPLE:',
        JSON.stringify({
          job_id: job.id,
          job_type: job.job_type,
          worker_rss_mb: message.rss_mb,
          worker_peak_rss_mb:
            message.peak_rss_mb,
          parent_rss_mb:
            getMemoryGuardSnapshot().rss_mb,
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
          status: message.status || null,
          worker_peak_rss_mb:
            message.peak_rss_mb || null,
        })
      )
    }
  })

  child.once('error', async (error) => {
    console.error(
      'HEAVY_MEDIA_WORKER_PROCESS_ERROR:',
      error
    )

    await markAbnormalWorkerFailure(
      job.id,
      workerId,
      String(error?.message || 'Worker process error.')
    )
  })

  child.once('exit', async (code, signal) => {
    settled = true
    clearTimeout(timeoutTimer)

    if (killTimer) {
      clearTimeout(killTimer)
    }

    console.log(
      'MEMORY_JOB_END:',
      JSON.stringify({
        job_id: job.id,
        job_type: job.job_type,
        worker_id: workerId,
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        parent_rss_mb:
          getMemoryGuardSnapshot().rss_mb,
      })
    )

    if (
      timedOut ||
      code !== 0
    ) {
      await markAbnormalWorkerFailure(
        job.id,
        workerId,
        timedOut
          ? 'Manga worker exceeded its time limit.'
          : `Manga worker exited with code ${code} and signal ${signal || 'none'}.`
      )
    }

    activeWorker = null
    scheduleNext(250)
  })
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
    const memory = getMemoryGuardSnapshot()

    if (
      memory.critical ||
      memory.blocked ||
      memory.rss_mb >= START_RSS_LIMIT_MB
    ) {
      console.warn(
        'MEMORY_GUARD_WAIT:',
        JSON.stringify({
          kind: 'heavy_media_worker',
          reason: 'insufficient_parent_headroom',
          parent_rss_mb: memory.rss_mb,
        })
      )
      return
    }

    const workerId = workerIdForJob()
    const job = await claimNextHeavyMediaJob({
      workerId,
      leaseSeconds: WORKER_LEASE_SECONDS,
      jobTypes: JOB_TYPES,
    })

    if (!job) return

    startClaimedWorker(job, workerId)
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
  if (!coordinatorStarted || !enabled()) {
    return false
  }

  scheduleNext(0)
  return true
}

export function startHeavyMediaWorkerCoordinator() {
  if (coordinatorStarted) return false

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
