import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

const DEFAULT_API_URL =
  'https://shadow-backend-kucw.onrender.com'
const POLL_MS = 2000
const JOB_TIMEOUT_MS = 30 * 60 * 1000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function ok(label, detail = '') {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
}

function fail(label, detail = '') {
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  process.exitCode = 1
}

function warn(label, detail = '') {
  console.warn(`WARN  ${label}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requiredEnv(names) {
  let valid = true

  for (const name of names) {
    const value = String(process.env[name] || '').trim()

    if (!value) {
      fail('Environment', `${name} is missing`)
      valid = false
    }
  }

  if (valid) {
    ok('Environment', 'required backend variables are present')
  }

  return valid
}

function checkRequiredFiles() {
  const required = [
    'server.js',
    'src/services/memoryGuard.service.js',
    'src/services/heavyMediaJob.service.js',
    'src/services/heavyMediaWorkerCoordinator.service.js',
    'src/services/mangaTempStorage.service.js',
    'src/middleware/mangaTempUpload.middleware.js',
    'src/controllers/mangaImageUploadV2.controller.js',
    'src/workers/mangaProcessing.worker.js',
    'src/routes/storyMedia.routes.js',
    'src/sql/heavy_media_jobs_setup.sql',
    'src/sql/heavy_media_jobs_hardening.sql',
  ]

  let valid = true

  for (const relativePath of required) {
    const absolutePath = path.resolve(process.cwd(), relativePath)

    if (!fs.existsSync(absolutePath)) {
      fail('Required file', `${relativePath} is missing`)
      valid = false
    }
  }

  if (valid) {
    ok('Required files', `${required.length} files found`)
  }

  return valid
}

async function checkModuleImports() {
  const modules = [
    '../src/services/memoryGuard.service.js',
    '../src/services/heavyMediaJob.service.js',
    '../src/services/heavyMediaWorkerCoordinator.service.js',
    '../src/services/mangaTempStorage.service.js',
    '../src/middleware/mangaTempUpload.middleware.js',
    '../src/controllers/mangaImageUploadV2.controller.js',
    '../src/routes/storyMedia.routes.js',
  ]

  for (const modulePath of modules) {
    try {
      await import(modulePath)
      ok('Module import', modulePath)
    } catch (error) {
      fail(
        'Module import',
        `${modulePath}: ${String(error?.message || error)}`
      )
    }
  }
}

async function checkDatabase() {
  try {
    const { data, error } = await supabase
      .from('heavy_media_jobs')
      .select('id,status,job_type')
      .limit(1)

    if (error) {
      fail(
        'Supabase heavy_media_jobs',
        `${error.code || 'DB_ERROR'}: ${error.message}`
      )
      return false
    }

    ok(
      'Supabase heavy_media_jobs',
      `table readable${Array.isArray(data) ? `, rows checked: ${data.length}` : ''}`
    )
    return true
  } catch (error) {
    fail(
      'Supabase heavy_media_jobs',
      String(error?.message || error)
    )
    return false
  }
}

async function checkBackendHealth(apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/api/health`)
    const text = await response.text()

    if (!response.ok) {
      fail(
        'Backend health',
        `HTTP ${response.status}: ${text.slice(0, 200)}`
      )
      return false
    }

    ok('Backend health', `HTTP ${response.status}`)
    return true
  } catch (error) {
    fail('Backend health', String(error?.message || error))
    return false
  }
}

function normalizeStatusUrl(apiUrl, statusUrl, jobId) {
  const fallback =
    `/api/story-media/manga-page-v2/jobs/${jobId}`
  const value = String(statusUrl || fallback).trim()

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  return `${apiUrl}${value.startsWith('/') ? value : `/${value}`}`
}

async function runMangaEndToEnd(apiUrl) {
  const token = String(
    process.env.MANGA_TEST_TOKEN || ''
  ).trim()
  const imagePath = String(
    process.env.MANGA_TEST_IMAGE || ''
  ).trim()

  if (!token || !imagePath) {
    warn(
      'Manga E2E',
      'skipped; set MANGA_TEST_TOKEN and MANGA_TEST_IMAGE to run upload test'
    )
    return
  }

  const absoluteImagePath = path.resolve(imagePath)

  if (!fs.existsSync(absoluteImagePath)) {
    fail('Manga E2E', `image not found: ${absoluteImagePath}`)
    return
  }

  const stat = fs.statSync(absoluteImagePath)

  if (!stat.isFile()) {
    fail('Manga E2E', 'MANGA_TEST_IMAGE must point to a file')
    return
  }

  if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
    fail(
      'Manga E2E',
      `image must be between 1 byte and 5 MB; got ${stat.size} bytes`
    )
    return
  }

  const body = fs.readFileSync(absoluteImagePath)
  const extension =
    path.extname(absoluteImagePath).toLowerCase()
  const contentType =
    extension === '.png'
      ? 'image/png'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/jpeg'

  let uploadResponse
  let uploadData

  try {
    uploadResponse = await fetch(
      `${apiUrl}/api/story-media/upload-manga-page-v2`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
          'Content-Length': String(body.length),
          'X-File-Name': path.basename(absoluteImagePath),
        },
        body,
      }
    )

    uploadData = await uploadResponse
      .json()
      .catch(() => ({}))
  } catch (error) {
    fail('Manga upload', String(error?.message || error))
    return
  }

  if (
    uploadResponse.status !== 202 ||
    uploadData?.ok === false ||
    !uploadData?.job_id
  ) {
    fail(
      'Manga upload',
      `expected HTTP 202 + job_id, got HTTP ${uploadResponse.status}: ${JSON.stringify(uploadData)}`
    )
    return
  }

  ok(
    'Manga upload queued',
    `job ${uploadData.job_id}`
  )

  const statusUrl = normalizeStatusUrl(
    apiUrl,
    uploadData.status_url,
    uploadData.job_id
  )
  const startedAt = Date.now()
  let lastStatus = ''

  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    let response
    let data

    try {
      response = await fetch(statusUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      })

      data = await response.json().catch(() => ({}))
    } catch (error) {
      warn(
        'Manga job status',
        `temporary request error: ${String(error?.message || error)}`
      )
      await sleep(POLL_MS)
      continue
    }

    if (!response.ok || data?.ok === false) {
      if (response.status >= 500) {
        warn(
          'Manga job status',
          `temporary HTTP ${response.status}`
        )
        await sleep(POLL_MS)
        continue
      }

      fail(
        'Manga job status',
        `HTTP ${response.status}: ${JSON.stringify(data)}`
      )
      return
    }

    const status = String(
      data.status || data.stage || ''
    )
      .trim()
      .toLowerCase()

    if (status && status !== lastStatus) {
      console.log(`INFO  Manga job — ${status}`)
      lastStatus = status
    }

    if (status === 'done') {
      const imageUrl =
        data.image_url ||
        data.imageUrl ||
        data.page?.image_url ||
        null
      const parts = Array.isArray(data.parts)
        ? data.parts
        : Array.isArray(data.page?.parts)
          ? data.page.parts
          : []

      if (!imageUrl) {
        fail(
          'Manga job done',
          'completed response has no image URL'
        )
        return
      }

      ok(
        'Manga job done',
        `${parts.length || data.part_count || 1} part(s)`
      )
      ok('Manga result URL', imageUrl)
      return
    }

    if (
      status === 'failed' ||
      status === 'cancelled'
    ) {
      fail(
        'Manga job',
        JSON.stringify(data.error || data)
      )
      return
    }

    await sleep(POLL_MS)
  }

  fail(
    'Manga job',
    'timed out after 30 minutes'
  )
}

async function main() {
  console.log('Shadow Manga System Check')
  console.log('=========================')

  checkRequiredFiles()

  const envReady = requiredEnv([
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_URL',
  ])

  await checkModuleImports()

  if (envReady) {
    await checkDatabase()
  }

  const apiUrl = String(
    process.env.MANGA_TEST_API_URL ||
    DEFAULT_API_URL
  )
    .trim()
    .replace(/\/+$/, '')

  await checkBackendHealth(apiUrl)
  await runMangaEndToEnd(apiUrl)

  if (process.exitCode) {
    console.error('\nFINAL RESULT: FAILED')
    process.exit(process.exitCode)
  }

  console.log('\nFINAL RESULT: PASS')
}

main().catch((error) => {
  console.error(
    'FINAL RESULT: FAILED',
    error
  )
  process.exit(1)
})
