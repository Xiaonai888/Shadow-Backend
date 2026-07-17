@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  exit /b 1
)

if not exist "APPLY_POST_10000_BACKEND.cjs" (
  echo ERROR: Missing APPLY_POST_10000_BACKEND.cjs
  exit /b 1
)

node APPLY_POST_10000_BACKEND.cjs
if errorlevel 1 exit /b 1

node --check src\controllers\readerPosts.controller.js
if errorlevel 1 exit /b 1

node --check src\controllers\authorPosts.controller.js
if errorlevel 1 exit /b 1

echo.
echo Backend post limit update completed successfully.
exit /b 0
