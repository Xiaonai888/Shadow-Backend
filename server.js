import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import healthRoutes from './src/routes/health.routes.js'
import slidesRoutes from './src/routes/slides.routes.js'
import authRoutes from './src/routes/auth.routes.js'
import booksRoutes from './src/routes/books.routes.js'
import usersRoutes from './src/routes/users.routes.js'

dotenv.config()

const app = express()

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
].filter(Boolean)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }

      return callback(new Error(`Not allowed by CORS: ${origin}`))
    },
    credentials: true,
  })
)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Shadow Backend API is running',
  })
})

app.use('/health', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/slides', slidesRoutes)
app.use('/api/books', booksRoutes)
app.use('/api/users', usersRoutes)

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Route not found',
  })
})

app.use((error, req, res, next) => {
  console.error('SERVER ERROR:', error)

  res.status(500).json({
    ok: false,
    message: 'Internal server error',
  })
})

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Shadow Backend running on port ${PORT}`)
})
