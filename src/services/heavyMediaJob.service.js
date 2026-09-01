import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireUuid(value, fieldName) {
  const safe = String(value || '').trim()

  if (!UUID_PATTERN.test(safe)) {
    const error = new Error(`${fieldName} must be a valid UUID.`)
    error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
    throw error
  }

  return safe
}

function cleanRequiredText(value, fieldName, maxLength) {
  const safe = String(value || '').trim()

  if (!safe || safe.length > maxLength) {
    const error = new Error(
      `${fieldName} is required and must be at most ${maxLength} characters.`
    )
    error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
    throw error
  }

  return safe
}

function cleanOptionalText(value, maxLength) {
  const safe = String(value || '').trim()

  if (!safe) return null
  return safe.slice(0, maxLength)
}

function requireInteger(value, fieldName, min, max) {
  const safe = Number(value)

  if (
    !Number.isInteger(safe) ||
    safe < min ||
    safe > max
  ) {
    const error = new Error(
      `${fieldName} must be an integer between ${min} and ${max}.`
    )
    error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
    throw error
  }

  return safe
}

function safeJsonObject(value, fieldName) {
  if (value == null) return {}

  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    const error = new Error(`${fieldName} must be an object.`)
    error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
    throw error
  }

  const serialized = JSON.stringify(value)

  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) {
    const error = new Error(`${fieldName} is too large.`)
    error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
    throw error
  }

  return value
}

function databaseError(error, fallbackCode) {
  const nextError = new Error(
    String(error?.message || 'Heavy media job database request failed.')
  )

  nextError.code =
    String(error?.code || '').trim() ||
    fallbackCode

  return nextError
}

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null
  return data || null
}

export async function createHeavyMediaJob({
  userId,
  jobType,
  tempObjectKey = null,
  payload = {},
  idempotencyKey = null,
  priority = 100,
  maxAttempts = 3,
  availableAt = null,
}) {
  const safeUserId = requireUuid(userId, 'userId')
  const safeJobType = cleanRequiredText(jobType, 'jobType', 80)
  const safeTempObjectKey = cleanOptionalText(tempObjectKey, 1000)
  const safeIdempotencyKey = cleanOptionalText(idempotencyKey, 160)
  const safePriority = requireInteger(
    priority,
    'priority',
    0,
    1000
  )
  const safeMaxAttempts = requireInteger(
    maxAttempts,
    'maxAttempts',
    1,
    10
  )
  const safePayload = safeJsonObject(payload, 'payload')

  const row = {
    user_id: safeUserId,
    job_type: safeJobType,
    temp_object_key: safeTempObjectKey,
    payload: safePayload,
    idempotency_key: safeIdempotencyKey,
    priority: safePriority,
    max_attempts: safeMaxAttempts,
  }

  if (availableAt) {
    const parsed = new Date(availableAt)

    if (Number.isNaN(parsed.getTime())) {
      const error = new Error('availableAt must be a valid date.')
      error.code = 'INVALID_HEAVY_MEDIA_JOB_INPUT'
      throw error
    }

    row.available_at = parsed.toISOString()
  }

  const { data, error } = await supabase
    .from('heavy_media_jobs')
    .insert(row)
    .select('*')
    .single()

  if (!error) return data

  if (
    error.code === '23505' &&
    safeIdempotencyKey
  ) {
    const {
      data: existing,
      error: existingError,
    } = await supabase
      .from('heavy_media_jobs')
      .select('*')
      .eq('user_id', safeUserId)
      .eq('idempotency_key', safeIdempotencyKey)
      .maybeSingle()

    if (!existingError && existing) {
      return existing
    }
  }

  throw databaseError(error, 'HEAVY_MEDIA_JOB_CREATE_FAILED')
}

export async function getHeavyMediaJob({
  jobId,
  userId = null,
}) {
  const safeJobId = requireUuid(jobId, 'jobId')

  let query = supabase
    .from('heavy_media_jobs')
    .select('*')
    .eq('id', safeJobId)

  if (userId) {
    query = query.eq(
      'user_id',
      requireUuid(userId, 'userId')
    )
  }

  const { data, error } = await query.maybeSingle()

  if (error) {
    throw databaseError(
      error,
      'HEAVY_MEDIA_JOB_READ_FAILED'
    )
  }

  return data || null
}

export async function claimNextHeavyMediaJob({
  workerId,
  leaseSeconds = 300,
  jobTypes = null,
}) {
  const safeWorkerId = cleanRequiredText(
    workerId,
    'workerId',
    160
  )
  const safeLeaseSeconds = requireInteger(
    leaseSeconds,
    'leaseSeconds',
    30,
    3600
  )

  let safeJobTypes = null

  if (Array.isArray(jobTypes) && jobTypes.length > 0) {
    safeJobTypes = [
      ...new Set(
        jobTypes.map((value) =>
          cleanRequiredText(value, 'jobType', 80)
        )
      ),
    ].slice(0, 30)
  }

  const { data, error } = await supabase.rpc(
    'claim_next_heavy_media_job',
    {
      p_worker_id: safeWorkerId,
      p_lease_seconds: safeLeaseSeconds,
      p_job_types: safeJobTypes,
    }
  )

  if (error) {
    throw databaseError(
      error,
      'HEAVY_MEDIA_JOB_CLAIM_FAILED'
    )
  }

  return firstRpcRow(data)
}

export async function renewHeavyMediaJobLease({
  jobId,
  workerId,
  leaseSeconds = 300,
}) {
  const { data, error } = await supabase.rpc(
    'renew_heavy_media_job_lease',
    {
      p_job_id: requireUuid(jobId, 'jobId'),
      p_worker_id: cleanRequiredText(
        workerId,
        'workerId',
        160
      ),
      p_lease_seconds: requireInteger(
        leaseSeconds,
        'leaseSeconds',
        30,
        3600
      ),
    }
  )

  if (error) {
    throw databaseError(
      error,
      'HEAVY_MEDIA_JOB_LEASE_RENEW_FAILED'
    )
  }

  return firstRpcRow(data)
}

export async function completeHeavyMediaJob({
  jobId,
  workerId,
  result = {},
  finalObjectKey = null,
}) {
  const { data, error } = await supabase.rpc(
    'complete_heavy_media_job',
    {
      p_job_id: requireUuid(jobId, 'jobId'),
      p_worker_id: cleanRequiredText(
        workerId,
        'workerId',
        160
      ),
      p_result: safeJsonObject(result, 'result'),
      p_final_object_key:
        cleanOptionalText(finalObjectKey, 1000),
    }
  )

  if (error) {
    throw databaseError(
      error,
      'HEAVY_MEDIA_JOB_COMPLETE_FAILED'
    )
  }

  return firstRpcRow(data)
}

export async function failHeavyMediaJob({
  jobId,
  workerId,
  errorCode = 'JOB_FAILED',
  errorMessage = '',
  retry = true,
  retryDelaySeconds = 30,
}) {
  const { data, error } = await supabase.rpc(
    'fail_heavy_media_job',
    {
      p_job_id: requireUuid(jobId, 'jobId'),
      p_worker_id: cleanRequiredText(
        workerId,
        'workerId',
        160
      ),
      p_error_code:
        cleanOptionalText(errorCode, 120) ||
        'JOB_FAILED',
      p_error_message:
        cleanOptionalText(errorMessage, 1000) || '',
      p_retry: Boolean(retry),
      p_retry_delay_seconds: requireInteger(
        retryDelaySeconds,
        'retryDelaySeconds',
        0,
        86400
      ),
    }
  )

  if (error) {
    throw databaseError(
      error,
      'HEAVY_MEDIA_JOB_FAIL_FAILED'
    )
  }

  return firstRpcRow(data)
}
