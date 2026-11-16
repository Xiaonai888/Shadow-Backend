import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const edits = [
  {
    file: 'server.js',
    before: "import adminStickerLibraryRoutes from './src/routes/adminStickerLibrary.routes.js'",
    after: "import adminStickerLibraryRoutes from './src/routes/adminStickerLibrary.routes.js'\nimport chatStoryStickersRoutes from './src/routes/chatStoryStickers.routes.js'",
  },
  {
    file: 'server.js',
    before: "app.use('/api/admin/sticker-library', adminStickerLibraryRoutes)",
    after: "app.use('/api/admin/sticker-library', adminStickerLibraryRoutes)\napp.use('/api/chat-story/stickers', chatStoryStickersRoutes)",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "['chat', 'aside', 'author_note', 'image', 'audio', 'notification'].includes(requestedType)",
    after: "['chat', 'aside', 'author_note', 'image', 'sticker', 'audio', 'notification'].includes(requestedType)",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "if (type === 'image' && !imageUrl) continue",
    after: "if (type === 'image' && !imageUrl) continue\nif (type === 'sticker' && (!imageUrl || !/^https:\\/\\/[^\\s]+$/i.test(imageUrl) || imageUrl.length > 2048)) return { error: 'Sticker requires a valid HTTPS image', messages: [] }",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "if (type !== 'image' && type !== 'audio' && !text) continue",
    after: "if (type !== 'image' && type !== 'sticker' && type !== 'audio' && !text) continue",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "if (type === 'image' && characterId && !characterIds.has(characterId)) {",
    after: "if (['image', 'sticker'].includes(type) && characterId && !characterIds.has(characterId)) {",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "character_id: ['chat', 'image', 'audio', 'notification'].includes(type) ? characterId : null,",
    after: "character_id: ['chat', 'image', 'sticker', 'audio', 'notification'].includes(type) ? characterId : null,",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "text: type === 'image' || type === 'audio' ? '' : text,",
    after: "text: ['image', 'sticker', 'audio'].includes(type) ? '' : text,",
  },
  {
    file: 'src/controllers/chatStoryEpisodes.controller.js',
    before: "image_url: ['image', 'notification'].includes(type) ? imageUrl : null,",
    after: "image_url: ['image', 'sticker', 'notification'].includes(type) ? imageUrl : null,",
  },
]

const staged = new Map()
for (const edit of edits) {
  const path = resolve(process.cwd(), edit.file)
  const current = staged.has(path) ? staged.get(path) : readFileSync(path, 'utf8')
  if (current.includes(edit.after)) continue
  const at = current.indexOf(edit.before)
  if (at < 0 || current.indexOf(edit.before, at + edit.before.length) !== -1) {
    throw new Error(`Cannot safely update ${edit.file}: source does not match latest GitHub version`)
  }
  staged.set(path, current.slice(0, at) + edit.after + current.slice(at + edit.before.length))
}
for (const [file, content] of staged) writeFileSync(file, content)
process.stdout.write(`Updated ${staged.size} Backend files.\n`)
