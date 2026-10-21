import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = resolve(backend, '..')
const roots = {
  backend,
  web: resolve(process.argv[2] || join(parent, 'Web-React-2')),
  admin: resolve(process.argv[3] || join(parent, 'AdminDashboard')),
}

const expected = [
  ['backend', 'server.js', 'd676a7f141c0fa69236cb5106300b41561db7cee'],
  ['backend', 'src/middleware/workKillSwitch.middleware.js', 'b8b3c487d01c9f1b063e97b03d76ac6cdc9323df'],
  ['backend', 'src/middleware/workDetector.middleware.js', '21e967dcd42d116e200df61645826683fcd976e0'],
  ['backend', 'src/services/workKillSwitch.service.js', '953708e3cfde5e0434f0e346dec07903f3433ff5'],
  ['backend', 'src/services/workKillSwitchBootstrap.service.js', '424f580bf5120d96775c449dd476134ea7599853'],
  ['backend', 'src/services/criticalCircuitPersistence.service.js', '3272d015c425e697cf2d3ef261c5505d63ef3bbc'],
  ['backend', 'src/services/criticalCircuitCanary.service.js', '3408529cea0822bb374ec05645564d750a3f68af'],
  ['backend', 'src/controllers/adminWorkKillSwitch.controller.js', 'b89011415493313f1dc97065daac2f7130d4187c'],
  ['backend', 'src/routes/adminWork.routes.js', '8468899267fff3516f2b0b5f2c9a09919f2a06c3'],
  ['backend', 'src/controllers/readingProgress.controller.js', '2e727a07108688335f724b6b207bae3fcca11dec'],
  ['backend', 'src/controllers/readerPresence.controller.js', '072720d00c56a4e8955b861a25a6213a97e1b5cf'],
  ['backend', 'src/controllers/storySectionRank.controller.js', 'dd61724eebfc17b11b6dfa67e82cffcbcbdbe75b'],
  ['backend', 'src/controllers/authorStoryViews.controller.js', '2776a0c5b80401b2af1435b9c352e999c5f58386'],
  ['backend', 'src/controllers/visitorAnalytics.controller.js', 'daef95c606218676fc87de047f9c79d8d300ced7'],
  ['web', 'src/hooks/useReadingProgressSync.js', '7229e954b584b6e893714529b6d4614dd02e8ba8'],
  ['web', 'src/utils/installReaderPresenceTracking.js', 'ee9b3a300fa13b1843128dfbd0007aaeeecb0541'],
  ['web', 'src/services/storySectionRankTracking.js', '6a8474688bf771640f09dd957247f5ffa03d46d9'],
  ['web', 'src/components/VisitorTracker.jsx', 'd1506794d0cb9f19f27c974c8acd1c8ef2646c9f'],
  ['admin', 'src/pages/AdminKillSwitchPage.jsx', '891fc9028f3a19e95bfa6cb5059e2db1b5a9d7fc'],
  ['admin', 'src/components/CriticalCanaryPanel.jsx', '60f647763a2bc3fe79866a3c01940b05311c911e'],
]

function blobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function sourceFiles(folder) {
  if (!existsSync(folder)) return []
  const result = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const name = join(folder, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(name))
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(name)) result.push(name)
  }
  return result
}

let errors = 0
let matched = 0
for (const [repo, relativePath, sha] of expected) {
  const filename = join(roots[repo], relativePath)
  if (!existsSync(filename)) {
    console.error(`MISSING ${repo}/${relativePath}`)
    errors += 1
    continue
  }
  const actual = blobHash(readFileSync(filename))
  if (actual !== sha) {
    console.error(`CHANGED ${repo}/${relativePath}: ${actual}`)
    errors += 1
  } else {
    matched += 1
  }
}

let syntaxChecked = 0
for (const filename of [join(backend, 'server.js'), ...sourceFiles(join(backend, 'src')), ...sourceFiles(join(backend, 'scripts'))]) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', timeout: 15000 })
  if (result.status !== 0) {
    console.error(`SYNTAX ERROR ${filename}: ${(result.stderr || result.error?.message || '').trim()}`)
    errors += 1
  } else {
    syntaxChecked += 1
  }
}

console.log(`Snapshot match: ${matched}/${expected.length}; backend syntax: ${syntaxChecked} files; errors: ${errors}`)
if (errors) {
  console.error('PRE-DEPLOY CHECK FAILED: resolve mismatches before deploying.')
  process.exitCode = 1
} else {
  console.log('STATIC PRE-DEPLOY CHECK PASSED. Runtime and production behavior are not tested.')
}
