import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import healthRoutes from './src/routes/health.routes.js'
import slidesRoutes from './src/routes/slides.routes.js'
import authRoutes from './src/routes/auth.routes.js'
import booksRoutes from './src/routes/books.routes.js'
import usersRoutes from './src/routes/users.routes.js'
import authorsRoutes from './src/routes/authors.routes.js'
import storiesRoutes from './src/routes/stories.routes.js'
import storyMediaRoutes from './src/routes/storyMedia.routes.js'
import publicStoriesRoutes from './src/routes/publicStories.routes.js'
import adminExclusiveRoutes from './src/routes/adminExclusive.routes.js'
import genresRoutes from './src/routes/genres.routes.js'
import commentsRoutes from './src/routes/comments.routes.js'

dotenv.config()

const app = express()

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  'https://shadowerabook.site',
  'https://www.shadowerabook.site',
  'https://admin.shadowerabook.site',
  'https://shadow-backend-kucw.onrender.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
].filter(Boolean)

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error(`Not allowed by CORS: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Name', 'X-Admin-Actor', 'X-Admin-Id'],
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'Shadow Backend API is running' })
})

app.use('/health', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/slides', slidesRoutes)
app.use('/api/books', booksRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/authors', authorsRoutes)
app.use('/api/stories', storiesRoutes)
app.use('/api/story-media', storyMediaRoutes)
app.use('/api/public', publicStoriesRoutes)
app.use('/api/admin/exclusive', adminExclusiveRoutes)
app.use('/api/genres', genresRoutes)
app.use('/api/comments', commentsRoutes)

app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Route not found' })
})

app.use((error, req, res, next) => {
  console.error('SERVER ERROR:', error)
  res.status(500).json({ ok: false, message: 'Internal server error' })
})

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Shadow Backend running on port ${PORT}`)
})
