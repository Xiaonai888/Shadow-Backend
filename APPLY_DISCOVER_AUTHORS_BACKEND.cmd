@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  exit /b 1
)

if not exist "src\controllers\authorDiscovery.controller.js" (
  echo ERROR: Missing authorDiscovery.controller.js
  exit /b 1
)

node APPLY_DISCOVER_AUTHORS_BACKEND.cjs
if errorlevel 1 exit /b 1

node --check src\controllers\authorDiscovery.controller.js
if errorlevel 1 exit /b 1

node --check src\routes\authors.routes.js
if errorlevel 1 exit /b 1

echo.
echo Discover Authors backend setup completed successfully.
exit /b 0
