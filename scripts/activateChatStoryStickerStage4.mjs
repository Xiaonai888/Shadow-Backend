import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const file = name => resolve(root, name)
const read = name => readFileSync(file(name), 'utf8')
const ensure = (condition, message) => { if (!condition) throw new Error(message) }

ensure(existsSync(file('scripts/applyChatStoryStickerStage2.mjs')), 'Stage 2 Backend patch script is missing')
ensure(existsSync(file('src/routes/chatStoryStickers.routes.js')), 'Stage 1 sticker routes are missing')
ensure(existsSync(file('src/controllers/chatStoryStickers.controller.js')), 'Stage 1 sticker controller is missing')
ensure(existsSync(file('src/sql/chat_story_stickers_v1.sql')), 'Stage 1 SQL migration is missing')

execFileSync(process.execPath, [file('scripts/applyChatStoryStickerStage2.mjs')], { cwd: root, stdio: 'inherit' })

const server = read('server.js')
const episode = read('src/controllers/chatStoryEpisodes.controller.js')
ensure(server.includes("import chatStoryStickersRoutes from './src/routes/chatStoryStickers.routes.js'"), 'Sticker import is missing in server.js')
ensure(server.includes("app.use('/api/chat-story/stickers', chatStoryStickersRoutes)"), 'Sticker routes are not mounted')
ensure(episode.includes("'image', 'sticker', 'audio', 'notification'"), 'Sticker message type is not accepted')
ensure(episode.includes("'image', 'sticker', 'notification'"), 'Sticker image URL is not persisted')
ensure(episode.includes("type === 'sticker' &&"), 'Sticker image validation is missing')

for (const name of [
  'server.js',
  'src/controllers/chatStoryEpisodes.controller.js',
  'src/controllers/chatStoryStickers.controller.js',
  'src/routes/chatStoryStickers.routes.js',
]) {
  execFileSync(process.execPath, ['--check', file(name)], { cwd: root, stdio: 'inherit' })
}

process.stdout.write('PASS: Backend Sticker integration and syntax checks. Commit and deploy only after Web integration and SQL verification.\n')
