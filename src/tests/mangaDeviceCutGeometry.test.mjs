import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  MANGA_DEVICE_PARTS_LIMITS as backendLimits,
  validateMangaDevicePartsManifest,
} from '../services/mangaDevicePartsPolicy.service.js'

const testDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const readerRoot = resolve(
  process.env.MANGA_READER_ROOT || resolve(testDirectory, '../../../Web-React-2')
)
const readerModule = (path) => pathToFileURL(resolve(readerRoot, path)).href

async function readerModules() {
  const [{ MANGA_DEVICE_POLICY }, { planMangaDeviceCuts }] = await Promise.all([
    import(readerModule('src/utils/mangaDeviceFirstPolicy.js')),
    import(readerModule('src/utils/mangaDeviceCutPlanner.js')),
  ])
  return { MANGA_DEVICE_POLICY, planMangaDeviceCuts }
}

test('Frontend and Backend device policy bounds agree', async () => {
  const { MANGA_DEVICE_POLICY: client } = await readerModules()
  const pairs = [
    ['maximumParts', 'maxParts'],
    ['partOverlap', 'overlapPixels'],
    ['maximumPartHeight', 'maxPartHeight'],
    ['maximumPartBytes', 'maxPartBytes'],
    ['maximumOutputBytes', 'maxTotalBytes'],
    ['maxDevicePixels', 'maxDevicePixels'],
    ['outputWidth', 'maxOutputWidth'],
  ]
  for (const [clientName, serverName] of pairs) {
    assert.equal(client[clientName], backendLimits[serverName], `${clientName}/${serverName}`)
  }
})

test('Cut planner always covers each page with exactly 2px consecutive overlaps', async () => {
  const { planMangaDeviceCuts } = await readerModules()
  const heights = [1, 2, 399, 400, 650, 800, 2399, 2400, 2401, 2999, 3000, 3001, 4800, 9000, 12000, 20000, 30000]
  for (let index = 0; index < 120; index += 1) {
    heights.push(1 + ((index * 104729) % 30000))
  }
  for (const height of heights) {
    const width = 400
    const ranges = planMangaDeviceCuts({ width, height })
    assert.ok(ranges.length >= 1 && ranges.length <= backendLimits.maxParts, `parts for ${height}`)
    let end = 0
    for (let index = 0; index < ranges.length; index += 1) {
      const part = ranges[index]
      assert.equal(part.top, index === 0 ? 0 : end - backendLimits.overlapPixels, `overlap for ${height}`)
      assert.ok(part.height >= 1 && part.height <= backendLimits.maxPartHeight, `height for ${height}`)
      end = part.top + part.height
    }
    assert.equal(end, height, `coverage for ${height}`)
    const normalized = validateMangaDevicePartsManifest({
      sourceWidth: width,
      sourceHeight: height,
      width,
      height,
      parts: ranges.map((part, partIndex) => ({
        partIndex,
        top: part.top,
        width,
        height: part.height,
        size: 1024,
        quality: 0.82,
      })),
    })
    assert.equal(normalized.parts.length, ranges.length)
  }
})

test('Planner rejects impossible dimensions before any image processing', async () => {
  const { planMangaDeviceCuts } = await readerModules()
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planMangaDeviceCuts({ width: 400, height }))
  }
  assert.throws(() => planMangaDeviceCuts({ width: 0, height: 2000 }))
})
