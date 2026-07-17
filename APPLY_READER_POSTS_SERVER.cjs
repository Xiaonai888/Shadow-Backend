$ErrorActionPreference = "Stop"

$path = Join-Path $PSScriptRoot "server.js"

if (-not (Test-Path $path)) {
  throw "server.js was not found in Shadow-Backend."
}

$content = Get-Content $path -Raw

$importLine = "import readerPostsRoutes from './src/routes/readerPosts.routes.js'"

if ($content -notmatch [regex]::Escape($importLine)) {
  $marker = "import savedPostsRoutes from './src/routes/savedPosts.routes.js'"

  if ($content -notmatch [regex]::Escape($marker)) {
    throw "Could not find savedPostsRoutes import."
  }

  $content = $content.Replace(
    $marker,
    "$marker`r`n$importLine"
  )
}

$routeLine = "app.use('/api/reader-posts', readerActionSpamGuard, readerPostsRoutes)"

if ($content -notmatch [regex]::Escape($routeLine)) {
  $marker = "app.use('/api/saved-posts', readerActionSpamGuard, savedPostsRoutes)"

  if ($content -notmatch [regex]::Escape($marker)) {
    throw "Could not find saved posts route."
  }

  $content = $content.Replace(
    $marker,
    "$marker`r`n$routeLine"
  )
}

Set-Content -Path $path -Value $content -Encoding utf8

Write-Host "Reader Posts route installed successfully."
