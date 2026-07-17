const fs = require('fs')
const path = require('path')

const root = process.cwd()
const serverPath = path.join(root, 'server.js')
const backupPath = path.join(
  root,
  'server.js.before-reader-posts.bak'
)

const controllerPath = path.join(
  root,
  'src',
  'controllers',
  'readerPosts.controller.js'
)

const routesPath = path.join(
  root,
  'src',
  'routes',
  'readerPosts.routes.js'
)

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(serverPath)) {
  fail('server.js was not found in the current Backend root.')
}

if (!fs.existsSync(controllerPath)) {
  fail('src/controllers/readerPosts.controller.js is missing.')
}

if (!fs.existsSync(routesPath)) {
  fail('src/routes/readerPosts.routes.js is missing.')
}

let content = fs.readFileSync(serverPath, 'utf8')
const original = content

const importLine =
  "import readerPostsRoutes from './src/routes/readerPosts.routes.js'"

const importMarker =
  "import savedPostsRoutes from './src/routes/savedPosts.routes.js'"

if (!content.includes(importLine)) {
  if (!content.includes(importMarker)) {
    fail('Could not find the savedPostsRoutes import marker in server.js.')
  }

  content = content.replace(
    importMarker,
    `${importMarker}\n${importLine}`
  )
}

const routeLine =
  "app.use('/api/reader-posts', readerActionSpamGuard, readerPostsRoutes)"

const routeMarker =
  "app.use('/api/saved-posts', readerActionSpamGuard, savedPostsRoutes)"

if (!content.includes(routeLine)) {
  if (!content.includes(routeMarker)) {
    fail('Could not find the saved-posts route marker in server.js.')
  }

  content = content.replace(
    routeMarker,
    `${routeMarker}\n${routeLine}`
  )
}

if (content === original) {
  console.log('Reader Posts route is already installed. No server.js changes were needed.')
  process.exit(0)
}

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, original, 'utf8')
  console.log('Backup created: server.js.before-reader-posts.bak')
}

fs.writeFileSync(serverPath, content, 'utf8')

console.log('server.js updated successfully.')
console.log('Added readerPostsRoutes import.')
console.log('Added /api/reader-posts route.')
