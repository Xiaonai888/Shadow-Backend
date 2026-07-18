const fs = require('fs')
const path = require('path')

const routesPath = path.join(
  process.cwd(),
  'src',
  'routes',
  'authors.routes.js'
)

function fail(message) {
  console.error(
    `ERROR: ${message}`
  )
  process.exit(1)
}

if (!fs.existsSync(routesPath)) {
  fail(
    'src/routes/authors.routes.js was not found.'
  )
}

let source = fs.readFileSync(
  routesPath,
  'utf8'
)
const original = source

const importLine =
  "import { getDiscoverAuthorSuggestions } from '../controllers/authorDiscovery.controller.js'"

if (!source.includes(importLine)) {
  const marker =
    "import { getFollowedAuthorPostsFeed } from '../controllers/followedAuthorPostsFeed.controller.js'"

  if (!source.includes(marker)) {
    fail(
      'Followed posts import marker was not found.'
    )
  }

  source = source.replace(
    marker,
    `${marker}\n${importLine}`
  )
}

const routeLine =
  "router.get('/discover', requireUser, getDiscoverAuthorSuggestions)"

if (!source.includes(routeLine)) {
  const marker =
    "router.get('/top', getTopAuthorPages)"

  if (!source.includes(marker)) {
    fail(
      'Top authors route marker was not found.'
    )
  }

  source = source.replace(
    marker,
    `${routeLine}\n${marker}`
  )
}

if (source === original) {
  console.log(
    'Discover Authors backend route is already installed.'
  )
  process.exit(0)
}

const backupPath =
  `${routesPath}.before-discover-authors.bak`

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(
    backupPath,
    original,
    'utf8'
  )
}

fs.writeFileSync(
  routesPath,
  source,
  'utf8'
)

console.log(
  'Discover Authors backend route installed.'
)
