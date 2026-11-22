import { supabase } from '../config/supabase.js'
import {
  assertMangaDevicePartsEnabled,
  createMangaDevicePartsIdentity,
  signMangaDevicePartsToken,
  verifyMangaDevicePartsToken,
} from './mangaDevicePartsAuth.service.js'
import {
  mangaDevicePartsError,
  MANGA_DEVICE_PARTS_LIMITS,
  validateMangaDevicePartsManifest,
} from './mangaDevicePartsPolicy.service.js'
import {
  createMangaDevicePartSignedUrl,
  mangaDevicePartKeys,
  verifyMangaDevicePart,
  copyVerifiedMangaDevicePart,
  deleteMangaDeviceTemporaryParts,
} from './mangaDevicePartsR2.service.js'

const TABLE = 'manga_device_part_sessions'
const INIT_WINDOW_MS = 10 * 60 * 1000
const MAX_SESSIONS_PER_WINDOW = 60
const FINALIZE_LEASE_RENEW_PARTS = 5
const cleanupInFlight = new Set()

function databaseError(error) {
  const failure = mangaDevicePartsError(503, 'MANGA_DEVICE_DATABASE_UNAVAILABLE', 'Manga Device-first session storage is unavailable', 'storage')
  failure.cause = error
  return failure
}

async function renewFinalizeLease(owner, sessionId, leaseToken) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', owner)
    .eq('status', 'processing')
    .eq('processing_token', leaseToken)
    .select('id')
    .maybeSingle()

  if (error) throw databaseError(error)
  if (!data) {
    throw mangaDevicePartsError(
      409,
      'MANGA_DEVICE_SESSION_LEASE_LOST',
      'Manga session finalization lease is no longer held',
      'finalize'
    )
  }
}

async function markTemporaryCleanupComplete(owner, sessionId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ temp_cleanup_completed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', owner)
    .eq('status', 'completed')
    .is('temp_cleanup_completed_at', null)

  if (error) throw databaseError(error)
}

async function lookupSession(owner, sessionId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id,user_id,status,manifest,result,expires_at,temp_cleanup_completed_at')
    .eq('id', sessionId)
    .eq('user_id', owner)
    .maybeSingle()
  if (error) throw databaseError(error)
  if (!data) {
    throw mangaDevicePartsError(404, 'MANGA_DEVICE_SESSION_NOT_FOUND', 'Manga upload session does not exist', 'finalize')
  }
  return data
}

function doneResponse(sessionId, result) {
  return {
    ok: true,
    code: 'MANGA_DEVICE_PARTS_COMPLETED',
    stage: 'complete',
    status: 'done',
    upload_id: sessionId,
    ...result,
  }
}

async function cleanupCompletedSession(owner, sessionId, partCount) {
  try {
    await deleteMangaDeviceTemporaryParts({ owner, sessionId, partCount })
  } catch (error) {
    console.error(
      'MANGA_DEVICE_TEMP_CLEANUP_FAILED:',
      JSON.stringify({
        session: String(sessionId).slice(-8),
        code: String(error?.code || 'R2_DELETE_FAILED'),
        message: String(error?.message || 'Cleanup failed').slice(0, 200),
      })
    )

    const publicUrl = String(process.env.R2_PUBLIC_URL || '')
      .trim()
      .replace(/\/+$/, '')
    if (!/^https:\/\//i.test(publicUrl)) {
      throw new Error('R2_PUBLIC_URL is missing for Manga cleanup retry')
    }

    const { deleteStoredMangaParts } = await import(
      './mangaPageStorage.service.js'
    )
    const temporaryParts = Array.from({ length: partCount }, (_, index) => ({
      image_url: `${publicUrl}/${mangaDevicePartKeys(owner, sessionId, index).temporary}`,
    }))
    const retry = await deleteStoredMangaParts(temporaryParts)
    if (retry.failed > 0 || retry.queue_failed > 0) {
      console.warn(
        'MANGA_DEVICE_TEMP_CLEANUP_RETRY:',
        JSON.stringify({
          session: String(sessionId).slice(-8),
          failed: retry.failed,
          queued: retry.queued,
          queue_failed: retry.queue_failed,
        })
      )
    }
    return
  }

  try {
    await markTemporaryCleanupComplete(owner, sessionId)
  } catch (error) {
    console.error(
      'MANGA_DEVICE_TEMP_CLEANUP_MARK_FAILED:',
      String(error?.message || error).slice(0, 200)
    )
  }
}

async function completedResponseWithCleanup(owner, sessionId, result, cleanupAt = null) {
  const partCount = Array.isArray(result?.parts)
    ? result.parts.length
    : 0

  if (
    !cleanupAt &&
    !cleanupInFlight.has(sessionId) &&
    partCount > 0 &&
    partCount <= MANGA_DEVICE_PARTS_LIMITS.maxParts
  ) {
    cleanupInFlight.add(sessionId)
    setImmediate(() => {
      void cleanupCompletedSession(owner, sessionId, partCount)
        .catch((error) => {
          console.error(
            'MANGA_DEVICE_TEMP_CLEANUP_RETRY_ERROR:',
            String(error?.message || error).slice(0, 200)
          )
        })
        .finally(() => {
          cleanupInFlight.delete(sessionId)
        })
    })
  }

  return doneResponse(sessionId, result)
}

export async function createMangaDevicePartsUploadSession({ userId, manifest }) {
  assertMangaDevicePartsEnabled()
  const { owner, sessionId } = createMangaDevicePartsIdentity(userId)
  const normalized = validateMangaDevicePartsManifest(manifest)
  const since = new Date(Date.now() - INIT_WINDOW_MS).toISOString()
  const { count, error: countError } = await supabase
    .from(TABLE)
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', owner)
    .gte('created_at', since)
  if (countError) throw databaseError(countError)
  if (Number(count || 0) >= MAX_SESSIONS_PER_WINDOW) {
    throw mangaDevicePartsError(429, 'MANGA_DEVICE_SESSION_RATE_LIMIT', 'Too many Manga upload sessions. Try again later', 'init')
  }

  const parts = normalized.parts.map((part) => {
    const keys = mangaDevicePartKeys(owner, sessionId, part.partIndex)
    return {
      part_index: part.partIndex,
      upload_url: createMangaDevicePartSignedUrl(keys.temporary, part.size),
      file_size: part.size,
      required_headers: { 'Content-Type': 'image/webp' },
    }
  })
  const uploadToken = signMangaDevicePartsToken({ owner, sessionId })
  const expiresAt = new Date(Date.now() + MANGA_DEVICE_PARTS_LIMITS.maxSessionSeconds * 1000).toISOString()
  const { error } = await supabase.from(TABLE).insert({
    id: sessionId,
    user_id: owner,
    manifest: normalized,
    status: 'pending',
    expires_at: expiresAt,
  })
  if (error) throw databaseError(error)

  return {
    ok: true,
    code: 'MANGA_DEVICE_PARTS_SESSION_CREATED',
    stage: 'init',
    upload_id: sessionId,
    upload_token: uploadToken,
    expires_at: expiresAt,
    expires_in_seconds: MANGA_DEVICE_PARTS_LIMITS.signedUrlSeconds,
    parts,
  }
}

export async function finalizeMangaDevicePartsUploadSession({ userId, uploadToken }) {
  assertMangaDevicePartsEnabled()
  const { owner, sessionId } = verifyMangaDevicePartsToken({ userId, uploadToken })
  let session = await lookupSession(owner, sessionId)

  if (session.status === 'completed' && session.result) {
    return completedResponseWithCleanup(owner, sessionId, session.result, session.temp_cleanup_completed_at)
  }
  if (Date.parse(session.expires_at) <= Date.now()) {
    throw mangaDevicePartsError(410, 'MANGA_DEVICE_SESSION_EXPIRED', 'Manga upload session expired', 'finalize')
  }

  const { data: leaseToken, error: claimError } = await supabase.rpc('claim_manga_device_part_session', {
    p_session_id: sessionId,
    p_user_id: owner,
  })
  if (claimError) throw databaseError(claimError)
  if (!leaseToken) {
    session = await lookupSession(owner, sessionId)
    if (session.status === 'completed' && session.result) {
      return completedResponseWithCleanup(owner, sessionId, session.result, session.temp_cleanup_completed_at)
    }
    throw mangaDevicePartsError(409, 'MANGA_DEVICE_SESSION_PROCESSING', 'Manga upload session is already being finalized', 'finalize')
  }

  try {
    const normalized = validateMangaDevicePartsManifest(session.manifest)
    const verified = []
    for (const part of normalized.parts) {
      if (part.partIndex % FINALIZE_LEASE_RENEW_PARTS === 0) {
        await renewFinalizeLease(owner, sessionId, leaseToken)
      }
      verified.push(await verifyMangaDevicePart({ owner, sessionId, part }))
    }

    const parts = []
    for (const part of normalized.parts) {
      if (part.partIndex % FINALIZE_LEASE_RENEW_PARTS === 0) {
        await renewFinalizeLease(owner, sessionId, leaseToken)
      }
      parts.push(await copyVerifiedMangaDevicePart({
        owner,
        sessionId,
        part,
        checked: verified[part.partIndex],
      }))
    }

    const first = parts[0]
    const result = {
      image_url: first.image_url,
      storage_path: first.storage_path,
      source_width: normalized.sourceWidth,
      source_height: normalized.sourceHeight,
      source_bytes: normalized.totalBytes,
      width: normalized.width,
      height: normalized.height,
      file_size: normalized.totalBytes,
      mime_type: 'image/webp',
      part_count: parts.length,
      parts,
      processed_by: 'device',
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update({
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
        processing_token: null,
        claimed_at: null,
      })
      .eq('id', sessionId)
      .eq('user_id', owner)
      .eq('status', 'processing')
      .eq('processing_token', leaseToken)
      .select('id')
      .maybeSingle()
    if (error) throw databaseError(error)
    if (!data) {
      throw mangaDevicePartsError(409, 'MANGA_DEVICE_SESSION_LEASE_LOST', 'Manga session finalization lease is no longer held', 'finalize')
    }
    return completedResponseWithCleanup(owner, sessionId, result)
  } catch (error) {
    const { error: resetError } = await supabase
      .from(TABLE)
      .update({ status: 'pending', processing_token: null, claimed_at: null })
      .eq('id', sessionId)
      .eq('user_id', owner)
      .eq('status', 'processing')
      .eq('processing_token', leaseToken)
    if (resetError) console.error('MANGA_DEVICE_SESSION_RESET_FAILED:', resetError.code || resetError.message)
    throw error
  }
}
