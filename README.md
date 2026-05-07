# Shadow-Backend

Backend API for the Shadow web-book app.

This repo connects:

```text
Web-React-2      -> Shadow-Backend -> Supabase
AdminDashboard  -> Shadow-Backend -> Supabase
```

Supabase is used only as Database + Storage. Your own AdminDashboard is still the admin panel.

## Files

```text
Shadow-Backend/
  package.json
  server.js
  .env.example
  .gitignore
  src/
    config/
      supabase.js
    routes/
      health.routes.js
      slides.routes.js
    controllers/
      slides.controller.js
    sql/
      setup.sql
```

## 1. Install

```bash
npm install
```

## 2. Create `.env`

Copy `.env.example` to `.env`.

```bash
cp .env.example .env
```

Fill in:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_STORAGE_BUCKET=media
```

Do not push `.env` to GitHub.

## 3. Supabase setup

Open Supabase SQL Editor and run:

```text
src/sql/setup.sql
```

Then create Storage bucket:

```text
Bucket name: media
Public: ON
```

## 4. Run local backend

```bash
npm run dev
```

Open:

```text
http://localhost:5000/health
```

You should see:

```json
{
  "ok": true,
  "service": "shadow-backend"
}
```

## 5. API routes

```text
GET    /health
GET    /api/slides?section_key=home_top_slider
POST   /api/slides
PUT    /api/slides/:id
DELETE /api/slides/:id
```

For `POST /api/slides`, use `multipart/form-data`.

Required file field name:

```text
image
```

Other fields:

```text
section_key
 title
 subtitle
 link_url
 order_index
 is_active
```

## 6. Connect Web-React-2

In `Web-React-2/.env.local`:

```env
VITE_API_URL=http://localhost:5000
```

When deployed:

```env
VITE_API_URL=https://your-backend-domain.com
```

## 7. Connect AdminDashboard

In `AdminDashboard/.env.local`:

```env
VITE_API_URL=http://localhost:5000
```

When deployed:

```env
VITE_API_URL=https://your-backend-domain.com
```

## 8. CORS

Local defaults are already allowed:

```text
http://localhost:5173
http://localhost:5174
```

For production, set backend `.env`:

```env
FRONTEND_URL=https://yourdomain.com
ADMIN_URL=https://admin.yourdomain.com
```
