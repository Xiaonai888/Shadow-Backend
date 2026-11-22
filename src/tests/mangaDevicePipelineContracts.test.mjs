import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const testDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const backendRoot = resolve(testDirectory, '../..')
const readerRoot = resolve(
  process.env.MANGA_READER_ROOT || resolve(backendRoot, '../Web-React-2')
)

const backend = (path) => readFileSync(resolve(backendRoot, path), 'utf8')
const reader = (path) => readFileSync(resolve(readerRoot, path), 'utf8')

test('Device-first routes require authentication and retain the fallback routes', () => {
  const routes = backend('src/routes/mangaDirectUpload.routes.js')
  const server = backend('server.js')
  assert.match(server, /app\.use\(['"]\/api\/story-media\/manga-direct['"]/)
  assert.match(routes, /['"]\/device-parts\/init['"]/)
  assert.match(routes, /['"]\/device-parts\/finalize['"]/)
  assert.match(routes, /requireUser,\s*handleRoute\(/)
  assert.match(routes, /['"]\/init['"]\s*,\s*mangaDirectSessionLimit/)
  assert.match(routes, /['"]\/finalize['"]\s*,\s*mangaDirectSessionLimit/)
})

test('Backend checks both feature flags before issuing device sessions', () => {
  const auth = backend('src/services/mangaDevicePartsAuth.service.js')
  assert.match(auth, /process\.env\.MANGA_DEVICE_PARTS_ENABLED\s*!==\s*['"]true['"]/) 
  assert.match(auth, /process\.env\.MANGA_DIRECT_UPLOAD_ENABLED\s*!==\s*['"]true['"]/) 
  assert.match(auth, /claims\?\.owner\s*!==\s*owner/)
})

test('R2 copy checks original ETag and verifies final object before returning a URL', () => {
  const r2 = backend('src/services/mangaDevicePartsR2.service.js')
  assert.match(r2, /CopySource:\s*`\//)
  assert.match(r2, /CopySourceIfMatch:\s*checked\.etag/)
  assert.match(r2, /await inspectObject\(final, part\)/)
  assert.match(r2, /Range:\s*['"]bytes=0-63['"]/) 
  assert.match(r2, /mangaDevicePartKeys[\s\S]*temporary:\s*`temp-processing\//)
  assert.match(r2, /final:\s*`episode-content\//)
})

test('Session finalization renews the lease, returns idempotently and records cleanup', () => {
  const sessions = backend('src/services/mangaDevicePartsUpload.service.js')
  const cleanup = backend('src/services/mangaR2DeleteRetry.service.js')
  assert.match(sessions, /async function renewFinalizeLease\(/)
  assert.match(sessions, /processing_token['"]?\s*,\s*leaseToken/)
  assert.match(sessions, /session\.status\s*===\s*['"]completed['"]\s*&&\s*session\.result/)
  assert.match(sessions, /markTemporaryCleanupComplete\(/)
  assert.match(cleanup, /\.in\(['"]status['"],\s*\[['"]pending['"],\s*['"]processing['"],\s*['"]completed['"]\]\)/)
  assert.match(cleanup, /temp_cleanup_completed_at/)
})

test('Browser falls back only when safe, and preserves the completed parts', () => {
  const client = reader('src/utils/mangaDirectUploadClient.js')
  const upload = reader('src/utils/mangaImageUtils.js')
  assert.match(client, /stageMangaDevicePartsUpload\(/)
  assert.match(client, /device-parts\/finalize/)
  assert.match(client, /fallbackSafe\s*=\s*true/)
  assert.match(upload, /error\?\.fallbackSafe\s*!==\s*true/)
  assert.match(upload, /stageMangaDirectUpload\(/)
  assert.match(upload, /parts:\s*parts|\.\.\.\(parts\s*\?\s*\{\s*parts\s*\}/)
})

test('Episode stores all 40 parts and Reader chooses parts instead of the first image URL', () => {
  const store = backend('src/services/episodePageParts.service.js')
  const editor = reader('src/pages/Author/EpisodeEditorPage.jsx')
  const reading = reader('src/pages/ReaderPage.jsx')
  assert.match(store, /MAX_PARTS_PER_PAGE\s*=\s*40/)
  assert.doesNotMatch(store, /\.slice\(0,\s*MAX_PARTS_PER_PAGE\)/)
  assert.match(store, /syncEpisodePageParts\(/)
  assert.match(editor, /function mangaPartsPatch\(/)
  assert.match(editor, /\.\.\.mangaPartsPatch\(page\)/)
  assert.match(reading, /const orderedParts\s*=/)
  assert.match(reading, /part_index/)
  assert.match(reading, /images\s*=\s*orderedParts\.length/)
})
