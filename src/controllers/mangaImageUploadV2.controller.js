import { supabase } from '../config/supabase.js'
import {
  getHeavyMediaJob,
} from '../services/heavyMediaJob.service.js'
import {
  wakeHeavyMediaWorkerCoordinator,
} from '../services/heavyMediaWorkerCoordinator.service.js'

function cleanText(value, maxLength = 300) {
  return String(value || '').trim().slice(0, maxLength)
}

function buildCompletedResponse(job) {
  const result =
    job?.result && typeof job.result === 'object'
      ? job.result
      : {}

  const parts = Array.isArray(result.parts)
    ? result.parts
    : []
  const firstPart = parts[0] || {}

  return {
    image_url:
      result.image_url ||
      firstPart.image_url ||
      null,
    imageUrl:
      result.image_url ||
      firstPart.image_url ||
      null,
    path:
      result.storage_path ||
      firstPart.storage_path ||
      null,
    source_format: result.source_format || null,
    source_width: Number(result.source_width || 0) || null,
    source_height: Number(result.source_height || 0) || null,
    source_bytes: Number(result.source_bytes || 0) || null,
    width: Number(result.width || 0) || null,
    height: Number(result.height || 0) || null,
    file_size: Number(result.file_size || 0) || null,
    mime_type: result.mime_type || 'image/webp',
    part_count:
      Number(result.part_count || parts.length || 0),
    parts,
    page: {
      image_url:
        result.image_url ||
        firstPart.image_url ||
        null,
      storage_path:
        result.storage_path ||
        firstPart.storage_path ||
        null,
      width: Number(result.width || 0) || null,
      height: Number(result.height || 0) || null,
      file_size: Number(result.file_size || 0) || null,
      mime_type: result.mime_type || 'image/webp',
      part_count:
        Number(result.part_count || parts.length || 0),
      parts,
    },
  }
}

export async function uploadMangaPageImageV2(req, res) {
  const userId = cleanText(req.user?.user_id, 80)
  const staged = req.mangaTempUpload

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      stage: 'auth',
      message: 'Please sign in again before uploading an image.',
    })
  }

  if (
    !staged?.jobId ||
    !staged?.tempObjectKey ||
    !Number(staged?.size)
  ) {
    return res.status(500).json({
      ok: false,
      code: 'MANGA_TEMP_JOB_MISSING',
      stage: 'queue',
      message:
        'The manga upload reached storage but its processing job was not created.',
    })
  }

  wakeHeavyMediaWorkerCoordinator()

  return res.status(202).json({
    ok: true,
    code: 'MANGA_PAGE_V2_QUEUED',
    stage: 'queued',
    status: 'queued',
    job_id: staged.jobId,
    upload_id: staged.uploadId,
    source_bytes: Number(staged.size),
    status_url:
      `/api/story-media/manga-page-v2/jobs/${staged.jobId}`,
    message:
      'The manga page was uploaded and queued for background processing.',
  })
}

export async function getMangaPageImageV2JobStatus(req, res) {
  const userId = cleanText(req.user?.user_id, 80)
  const jobId = cleanText(req.params?.jobId, 80)

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Please sign in again.',
    })
  }

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      code: 'MANGA_JOB_ID_REQUIRED',
      message: 'Manga processing job ID is required.',
    })
  }

  try {
    const job = await getHeavyMediaJob({
      jobId,
      userId,
    })

    if (!job || job.job_type !== 'manga_page_v2') {
      return res.status(404).json({
        ok: false,
        code: 'MANGA_JOB_NOT_FOUND',
        message: 'Manga processing job was not found.',
      })
    }

    const status = String(job.status || 'queued')
    const response = {
      ok: true,
      code: 'MANGA_PAGE_V2_JOB_STATUS',
      job_id: job.id,
      status,
      stage: status,
      attempt_count: Number(job.attempt_count || 0),
      max_attempts: Number(job.max_attempts || 0),
      created_at: job.created_at || null,
      started_at: job.started_at || null,
      finished_at: job.finished_at || null,
    }

    if (status === 'done') {
      Object.assign(
        response,
        buildCompletedResponse(job)
      )
    }

    if (status === 'failed') {
      response.error = {
        code:
          cleanText(job.error_code, 120) ||
          'MANGA_PROCESSING_FAILED',
        message:
          cleanText(job.error_message, 1000) ||
          'The manga page could not be processed.',
      }
    }

    return res.json(response)
  } catch (error) {
    console.error(
      'MANGA V2 JOB STATUS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      code: 'MANGA_JOB_STATUS_FAILED',
      message:
        'The manga processing status could not be loaded.',
    })
  }
}

export async function cleanupTemporaryMangaPartsV2(req, res) {
  const userId = cleanText(req.user?.user_id, 80)

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Please sign in again.',
    })
  }

  const urls = [
    ...new Set(
      (Array.isArray(req.body?.urls) ? req.body.urls : [])
        .slice(0, 10)
        .map((url) => cleanText(url, 2000))
        .filter(Boolean)
    ),
  ]

  if (!urls.length) {
    return res.json({
      ok: true,
      requested: 0,
      protected: 0,
      deleted: 0,
      failed: 0,
    })
  }

  const publicBaseUrl = String(
    process.env.R2_PUBLIC_URL || ''
  ).replace(/\/+$/, '')

  if (!publicBaseUrl) {
    return res.status(500).json({
      ok: false,
      code: 'R2_PUBLIC_URL_MISSING',
      message: 'Storage configuration is unavailable.',
    })
  }

  const ownedPrefix =
    `${publicBaseUrl}/episode-content/${userId}/manga-v2/`

  if (urls.some((url) => !url.startsWith(ownedPrefix))) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_MANGA_CLEANUP_URL',
      message: 'One or more manga files cannot be removed.',
    })
  }

  try {
    const [
      { data: partRows, error: partError },
      { data: pageRows, error: pageError },
    ] = await Promise.all([
      supabase
        .from('episode_page_parts')
        .select('image_url')
        .in('image_url', urls),
      supabase
        .from('episode_pages')
        .select('image_url')
        .in('image_url', urls),
    ])

    if (partError) throw partError
    if (pageError) throw pageError

    const protectedUrls = new Set([
      ...(partRows || []).map((row) => row.image_url),
      ...(pageRows || []).map((row) => row.image_url),
    ])

    const removableUrls = urls.filter(
      (url) => !protectedUrls.has(url)
    )

    const {
      deleteStoredMangaParts,
    } = await import(
      '../services/mangaPageStorage.service.js'
    )

    const result = await deleteStoredMangaParts(
      removableUrls.map((imageUrl) => ({
        image_url: imageUrl,
      }))
    )

    return res.json({
      ok: true,
      requested: urls.length,
      protected: protectedUrls.size,
      deleted: result.deleted,
      failed: result.failed,
    })
  } catch (error) {
    console.error(
      'MANGA V2 TEMP CLEANUP ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      code: 'MANGA_V2_TEMP_CLEANUP_FAILED',
      message: 'Temporary manga files could not be cleaned up.',
    })
  }
}
