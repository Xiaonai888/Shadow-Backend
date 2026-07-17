@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  exit /b 1
)

node APPLY_READER_STORIES_BACKEND.cjs
if errorlevel 1 exit /b 1

node --check src\controllers\readerStories.controller.js
if errorlevel 1 exit /b 1

node --check src\controllers\discoverStories.controller.js
if errorlevel 1 exit /b 1

node --check src\routes\readerStories.routes.js
if errorlevel 1 exit /b 1

node --check src\routes\discoverStories.routes.js
if errorlevel 1 exit /b 1

node --check server.js
if errorlevel 1 exit /b 1

echo.
echo Reader Stories backend setup completed.
exit /b 0
