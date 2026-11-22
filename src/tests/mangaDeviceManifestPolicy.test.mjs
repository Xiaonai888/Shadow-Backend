import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANGA_DEVICE_PARTS_LIMITS as limits,
  validateMangaDevicePartsManifest as validate,
} from '../services/mangaDevicePartsPolicy.service.js'

function segment(index, top, height, width = 400, size = 1024) {
  return { partIndex: index, top, width, height, size, quality: 0.82 }
}

function manifest(height, parts, width = 400) {
  return {
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    parts,
  }
}

function overlappingParts(count, partHeight = 750, width = 400, size = 1024) {
  const parts = []
  let end = 0
  for (let index = 0; index < count; index += 1) {
    const top = index === 0 ? 0 : end - limits.overlapPixels
    const height = index === 0 ? partHeight : partHeight + limits.overlapPixels
    parts.push(segment(index, top, height, width, size))
    end = top + height
  }
  return { parts, height: end }
}

test('Device policy stays within the required release limits', () => {
  assert.equal(limits.maxParts, 40)
  assert.equal(limits.overlapPixels, 2)
  assert.equal(limits.maxPartBytes, 2 * 1024 * 1024)
  assert.equal(limits.maxTotalBytes, 24 * 1024 * 1024)
  assert.equal(limits.maxDevicePixels, 24_000_000)
  assert.ok(limits.signedUrlSeconds >= 600)
  assert.ok(limits.signedUrlSeconds < limits.maxSessionSeconds)
})

test('40 contiguous overlapping parts are accepted in order', () => {
  const { parts, height } = overlappingParts(40)
  assert.equal(height, 30000)
  const result = validate(manifest(height, parts))
  assert.equal(result.parts.length, 40)
  assert.equal(result.parts.at(-1).top + result.parts.at(-1).height, height)
  assert.equal(result.totalBytes, 40 * 1024)
  assert.deepEqual(result.parts.map((part) => part.partIndex), Array.from({ length: 40 }, (_, index) => index))
})

test('41 parts fail without silently discarding the final part', () => {
  const { parts, height } = overlappingParts(41, 700)
  assert.throws(() => validate(manifest(height, parts)), (error) =>
    error.code === 'MANGA_DEVICE_PART_COUNT_INVALID' && error.statusCode === 422
  )
})

test('one missing overlap pixel or a wrong part index is rejected', () => {
  const correct = manifest(4800, [
    segment(0, 0, 2401),
    segment(1, 2399, 2401),
  ])
  assert.equal(validate(correct).parts.length, 2)
  const gap = structuredClone(correct)
  gap.parts[1].top += 1
  gap.parts[1].height -= 1
  assert.throws(() => validate(gap), (error) => error.code === 'MANGA_DEVICE_PART_GAP')
  const wrongIndex = structuredClone(correct)
  wrongIndex.parts[1].partIndex = 7
  assert.throws(() => validate(wrongIndex), (error) => error.code === 'MANGA_DEVICE_PART_GEOMETRY_INVALID')
})

test('24MP is permitted and 25MP falls back rather than starting a session', () => {
  const allowed = {
    sourceWidth: 4000,
    sourceHeight: 6000,
    width: 1000,
    height: 1500,
    parts: [segment(0, 0, 1500, 1000)],
  }
  assert.equal(validate(allowed).sourceWidth, 4000)
  const oversize = {
    ...allowed,
    sourceWidth: 5000,
    sourceHeight: 5000,
    width: 1000,
    height: 1000,
    parts: [segment(0, 0, 1000, 1000)],
  }
  assert.throws(() => validate(oversize), (error) => error.code === 'MANGA_DEVICE_SOURCE_TOO_LARGE')
})

test('per-part byte ceiling and total 24MB budget are enforced', () => {
  const largePart = manifest(1000, [segment(0, 0, 1000, 400, limits.maxPartBytes + 1)])
  assert.throws(() => validate(largePart), (error) => error.code === 'MANGA_DEVICE_MANIFEST_INVALID')

  const { parts, height } = overlappingParts(13, 1000, 400, limits.maxPartBytes)
  assert.throws(() => validate(manifest(height, parts)), (error) => error.code === 'MANGA_DEVICE_PARTS_INCOMPLETE')
})

test('last part must end at the page bottom', () => {
  const incomplete = manifest(3000, [segment(0, 0, 2998)])
  assert.throws(() => validate(incomplete), (error) => error.code === 'MANGA_DEVICE_PARTS_INCOMPLETE')
})
