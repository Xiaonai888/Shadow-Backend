const fs = require('fs')
const path = require('path')

const serverPath = path.join(
  process.cwd(),
  'server.js'
)

if (!fs.existsSync(serverPath)) {
  console.error(
    'ERROR: server.js was not found.'
  )
  process.exit(1)
}

let source = fs.readFileSync(
  serverPath,
  'utf8'
)
const original = source

function insertAfter(marker, value) {
  if (source.includes(value)) return

  if (!source.includes(marker)) {
    console.error(
      `ERROR: Marker not found: ${marker}`
    )
    process.exit(1)
  }

  source = source.replace(
    marker,
    `${marker}\n${value}`
  )
}

insertAfter(
  "import authorStoriesRoutes from './src/routes/authorStories.routes.js'",
  "import readerStoriesRoutes from './src/routes/readerStories.routes.js'\nimport discoverStoriesRoutes from './src/routes/discoverStories.routes.js'\nimport { startReaderStoriesCleanup } from './src/controllers/readerStories.controller.js'"
)

insertAfter(
  "app.use('/api/author-stories', readerActionSpamGuard, authorStoriesRoutes)",
  "app.use('/api/reader-stories', readerActionSpamGuard, readerStoriesRoutes)\napp.use('/api/discover-stories', readerActionSpamGuard, discoverStoriesRoutes)"
)

if (
  !source.includes(
    'startReaderStoriesCleanup()'
  )
) {
  const marker =
    'startAuthorStoriesCleanup()'

  if (!source.includes(marker)) {
    console.error(
      'ERROR: Author cleanup marker was not found.'
    )
    process.exit(1)
  }

  source = source.replace(
    marker,
    `${marker}\n  startReaderStoriesCleanup()`
  )
}

if (source === original) {
  console.log(
    'Reader Stories backend is already connected.'
  )
  process.exit(0)
}

const backupPath = path.join(
  process.cwd(),
  'server.js.before-reader-stories.bak'
)

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(
    backupPath,
    original,
    'utf8'
  )
}

fs.writeFileSync(
  serverPath,
  source,
  'utf8'
)

console.log(
  'server.js updated successfully.'
)
