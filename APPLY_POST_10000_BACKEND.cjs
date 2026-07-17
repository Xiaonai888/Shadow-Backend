const fs = require('fs')
const path = require('path')

const root = process.cwd()

const files = {
  readerPosts: path.join(root, 'src', 'controllers', 'readerPosts.controller.js'),
  authorPosts: path.join(root, 'src', 'controllers', 'authorPosts.controller.js'),
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function readFile(filePath) {
  if (!fs.existsSync(filePath)) fail(`Missing file: ${filePath}`)
  return fs.readFileSync(filePath, 'utf8')
}

function replaceRequired(source, oldText, newText, label) {
  if (source.includes(newText)) return source
  if (!source.includes(oldText)) fail(`Marker not found: ${label}`)
  return source.replace(oldText, newText)
}

function saveFile(filePath, original, updated) {
  if (updated === original) {
    console.log(`Already updated: ${filePath}`)
    return
  }

  const backupPath = `${filePath}.before-10000-post-limit.bak`
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original, 'utf8')
  fs.writeFileSync(filePath, updated, 'utf8')
  console.log(`Updated: ${filePath}`)
}

function updateReaderPosts() {
  const filePath = files.readerPosts
  const original = readFile(filePath)
  const updated = replaceRequired(
    original,
    'const MAX_POST_LENGTH = 1000',
    'const MAX_POST_LENGTH = 10000',
    'Reader Post backend limit'
  )

  saveFile(filePath, original, updated)
}

function updateAuthorPosts() {
  const filePath = files.authorPosts
  const original = readFile(filePath)
  let source = original

  source = replaceRequired(
    source,
    `const AUTHOR_POSTS_DAILY_LIMIT = 5\nconst AUTHOR_POST_IMAGES_LIMIT = 5`,
    `const AUTHOR_POSTS_DAILY_LIMIT = 5\nconst AUTHOR_POST_IMAGES_LIMIT = 5\nconst AUTHOR_POST_CONTENT_LIMIT = 10000`,
    'Author Post backend limit constant'
  )

  source = replaceRequired(
    source,
    `    if (content.length > 5000) {\n      return res.status(400).json({ ok: false, message: 'Post content is too long' })\n    }`,
    `    if (content.length > AUTHOR_POST_CONTENT_LIMIT) {\n      return res.status(400).json({\n        ok: false,\n        message: \`Post content must be \${AUTHOR_POST_CONTENT_LIMIT.toLocaleString()} characters or fewer\`,\n      })\n    }`,
    'Author Post backend validation'
  )

  saveFile(filePath, original, source)
}

updateReaderPosts()
updateAuthorPosts()

console.log('')
console.log('Backend post limits updated to 10,000 characters.')
