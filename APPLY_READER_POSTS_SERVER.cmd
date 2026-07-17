@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  exit /b 1
)

if not exist "src\controllers\readerPosts.controller.js" (
  echo ERROR: Missing src\controllers\readerPosts.controller.js
  exit /b 1
)

if not exist "src\routes\readerPosts.routes.js" (
  echo ERROR: Missing src\routes\readerPosts.routes.js
  exit /b 1
)

if not exist "APPLY_READER_POSTS_SERVER.cjs" (
  echo ERROR: Missing APPLY_READER_POSTS_SERVER.cjs
  exit /b 1
)

node APPLY_READER_POSTS_SERVER.cjs
if errorlevel 1 exit /b 1

node --check server.js
if errorlevel 1 exit /b 1

node --check src\controllers\readerPosts.controller.js
if errorlevel 1 exit /b 1

node --check src\routes\readerPosts.routes.js
if errorlevel 1 exit /b 1

echo.
echo Reader Posts Backend setup completed successfully.
exit /b 0
