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
  ['backend', 'server.js', 'b60cea5f1c9f50f13f8e56f5b20c3bc974f728b5'],
  ['backend', 'src/middleware/workKillSwitch.middleware.js', 'b8b3c487d01c9f1b063e97b03d76ac6cdc9323df'],
  ['backend', 'src/middleware/workDetector.middleware.js', '21e967dcd42d116e200df61645826683fcd976e0'],
  ['backend', 'src/services/workKillSwitch.service.js', '953708e3cfde5e0434f0e346dec07903f3433ff5'],
  ['backend', 'src/services/workKillSwitchBootstrap.service.js', '424f580bf5120d96775c449dd476134ea7599853'],
  ['backend', 'src/services/criticalCircuitPersistence.service.js', '3272d015c425e697cf2d3ef261c5505d63ef3bbc'],
  ['backend', 'src/services/criticalCircuitCanary.service.js', '3408529cea0822bb374ec05645564d750a3f68af'],
  ['backend', 'src/controllers/adminWorkKillSwitch.controller.js', 'b89011415493313f1dc97065daac2f7130d4187c'],
  ['backend', 'src/routes/adminWork.routes.js', '8468899267fff3516f2b0b5f2c9a09919f2a06c3'],
  ['backend', 'src/controllers/readingProgress.controller.js', '741930e6d15f65c5c55769a813664d68afba1afb'],
  ['backend', 'src/controllers/readerPresence.controller.js', '072720d00c56a4e8955b861a25a6213a97e1b5cf'],
  ['backend', 'src/controllers/storySectionRank.controller.js', 'd9ecd4509f8609b2497bd21d7eea1031a3259bc1'],
  ['backend', 'src/controllers/authorStoryViews.controller.js', '2776a0c5b80401b2af1435b9c352e999c5f58386'],
  ['backend', 'src/controllers/visitorAnalytics.controller.js', 'ef1ef9f2ca1cc0de4cd68b101fdd7d09535f6367'],
  ['web', 'src/hooks/useReadingProgressSync.js', '87aa895bdcacc067aa02477c35eca0f74e5a59c3'],
  ['web', 'src/utils/installReaderPresenceTracking.js', '89df99f686d3f7035e976dc7caf8d18b77bfc758'],
  ['web', 'src/services/storySectionRankTracking.js', 'e390654965f81ad341a9825a3dc81116d9378a8e'],
  ['web', 'src/components/VisitorTracker.jsx', '2125f9873bd941cde5939f9d4b8ac1a56dd89fb5'],
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
