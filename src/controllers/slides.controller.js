function formatMegabytes(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`
}

function ensureStyles() {
  if (document.getElementById('shadow-media-upload-progress-styles')) return

  const style = document.createElement('style')
  style.id = 'shadow-media-upload-progress-styles'
  style.textContent = `
    .shadow-upload-progress-layer {
      position: fixed;
      inset: 0;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(15, 23, 42, 0.55);
      padding: 20px;
      backdrop-filter: blur(5px);
    }

    .shadow-upload-progress-card {
      width: min(460px, 100%);
      border: 1px solid #E2E8F0;
      border-radius: 24px;
      background: #FFFFFF;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
      padding: 24px;
      color: #0F172A;
    }

    .shadow-upload-progress-kicker {
      color: #4F46E5;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .shadow-upload-progress-card h2 {
      margin: 7px 0 4px;
      font-size: 22px;
      font-weight: 950;
    }

    .shadow-upload-progress-status {
      margin: 0;
      color: #64748B;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.5;
    }

    .shadow-upload-progress-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-top: 22px;
    }

    .shadow-upload-progress-percent {
      font-size: 38px;
      font-weight: 950;
      line-height: 1;
    }

    .shadow-upload-progress-size {
      color: #475569;
      font-size: 13px;
      font-weight: 850;
      text-align: right;
    }

    .shadow-upload-progress-track {
      height: 12px;
      overflow: hidden;
      border-radius: 999px;
      background: #EDE9FE;
      margin-top: 14px;
    }

    .shadow-upload-progress-bar {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #4F46E5, #7C3AED);
      transition: width 180ms ease;
    }

    .shadow-upload-progress-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 16px;
    }

    .shadow-upload-progress-detail {
      border-radius: 14px;
      background: #F8FAFC;
      padding: 12px;
    }

    .shadow-upload-progress-detail span {
      display: block;
      color: #94A3B8;
      font-size: 10px;
      font-weight: 850;
      text-transform: uppercase;
    }

    .shadow-upload-progress-detail strong {
      display: block;
      margin-top: 4px;
      color: #0F172A;
      font-size: 13px;
      font-weight: 900;
    }

    .shadow-upload-progress-processing .shadow-upload-progress-bar {
      width: 100%;
      animation: shadow-upload-processing 1.2s ease-in-out infinite;
    }

    .shadow-upload-progress-success .shadow-upload-progress-bar {
      width: 100%;
      background: #16A34A;
      animation: none;
    }

    .shadow-upload-progress-error .shadow-upload-progress-bar {
      background: #DC2626;
      animation: none;
    }

    @keyframes shadow-upload-processing {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

function createProgressView(fileCount, totalBytes) {
  ensureStyles()

  const layer = document.createElement('div')
  layer.className = 'shadow-upload-progress-layer'
  layer.innerHTML = `
    <div class="shadow-upload-progress-card">
      <div class="shadow-upload-progress-kicker">Shadow Media Library</div>
      <h2>Uploading ${fileCount} images</h2>
      <p class="shadow-upload-progress-status">Preparing one batch for upload...</p>

      <div class="shadow-upload-progress-row">
        <div class="shadow-upload-progress-percent">0%</div>
        <div class="shadow-upload-progress-size">0.0 MB / ${formatMegabytes(totalBytes)}</div>
      </div>

      <div class="shadow-upload-progress-track">
        <div class="shadow-upload-progress-bar"></div>
      </div>

      <div class="shadow-upload-progress-details">
        <div class="shadow-upload-progress-detail">
          <span>Images</span>
          <strong>${fileCount} files</strong>
        </div>
        <div class="shadow-upload-progress-detail">
          <span>Total size</span>
          <strong>${formatMegabytes(totalBytes)}</strong>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(layer)

  const card = layer.querySelector('.shadow-upload-progress-card')
  const title = layer.querySelector('h2')
  const status = layer.querySelector('.shadow-upload-progress-status')
  const percent = layer.querySelector('.shadow-upload-progress-percent')
  const size = layer.querySelector('.shadow-upload-progress-size')
  const bar = layer.querySelector('.shadow-upload-progress-bar')

  return {
    updateUpload(progress, estimatedLoadedBytes) {
      const safeProgress = Math.max(0, Math.min(100, Math.round(progress)))
      percent.textContent = `${safeProgress}%`
      size.textContent = `${formatMegabytes(estimatedLoadedBytes)} / ${formatMegabytes(totalBytes)}`
      bar.style.width = `${safeProgress}%`
      status.textContent = 'Sending all images in one batch...'
    },
    updateDirect(loadedBytes, fileIndex, totalFiles, stage) {
      const safeBytes = Math.max(0, Math.min(totalBytes, Number(loadedBytes || 0)))
      const progress = totalBytes ? Math.min(99, Math.round(safeBytes / totalBytes * 100)) : 0
      card.classList.remove('shadow-upload-progress-processing')
      percent.textContent = `${progress}%`
      size.textContent = `${formatMegabytes(safeBytes)} / ${formatMegabytes(totalBytes)}`
      bar.style.width = `${progress}%`
      status.textContent = stage === 'fallback'
        ? `Using existing upload service for remaining images (${fileIndex}/${totalFiles})...`
        : stage === 'finalizing'
          ? `Saving image ${fileIndex} of ${totalFiles} to Cloudflare...`
          : `Uploading image ${fileIndex} of ${totalFiles} directly to Cloudflare...`
    },
    showProcessing() {
      card.classList.add('shadow-upload-progress-processing')
      percent.textContent = '100%'
      size.textContent = `${formatMegabytes(totalBytes)} / ${formatMegabytes(totalBytes)}`
      bar.style.width = '100%'
      status.textContent = 'Upload received. Compressing and saving images to Cloudflare...'
    },
    showSuccess() {
      card.classList.remove('shadow-upload-progress-processing')
      card.classList.add('shadow-upload-progress-success')
      title.textContent = 'Upload complete'
      percent.textContent = '100%'
      status.textContent = `${fileCount} images were compressed and saved successfully.`
    },
    showError(message) {
      card.classList.remove('shadow-upload-progress-processing')
      card.classList.add('shadow-upload-progress-error')
      title.textContent = 'Upload failed'
      status.textContent = message || 'The images could not be uploaded.'
    },
    remove(delay = 0) {
      window.setTimeout(() => layer.remove(), delay)
    },
  }
}

const DIRECT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DIRECT_MEDIA_MAX_BYTES = 5 * 1024 * 1024
let directUnavailableUntil = 0

function uploadError(message, status = 0, code = '') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

async function readMediaResponse(response, fallbackMessage) {
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok === false) {
    throw uploadError(
      result.message || fallbackMessage,
      response.status,
      result.code || ''
    )
  }
  return result
}

function uploadDirectImageBytes(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.timeout = 180000
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total) {
        onProgress(Math.min(file.size, event.loaded))
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size)
        resolve()
      } else {
        reject(uploadError('Cloudflare R2 rejected the image', xhr.status))
      }
    })
    xhr.addEventListener('error', () => reject(uploadError('Cannot connect to Cloudflare R2')))
    xhr.addEventListener('timeout', () => reject(uploadError('Cloudflare R2 upload timed out', 408)))
    xhr.addEventListener('abort', () => reject(uploadError('Image upload was canceled', 0, 'DIRECT_UPLOAD_CANCELED')))
    xhr.send(file)
  })
}

async function uploadImageDirect(apiUrl, token, file, onProgress) {
  const initResponse = await fetch(`${apiUrl}/api/media-direct/admin/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      category: 'admin_media_library',
      mime_type: file.type,
      file_size: file.size,
    }),
  })
  const init = await readMediaResponse(initResponse, 'Cannot start direct image upload')
  if (!init.upload_url || !init.upload_token) {
    throw uploadError('Cloudflare upload session is unavailable', 503)
  }

  await uploadDirectImageBytes(init.upload_url, file, onProgress)

  const finalizeResponse = await fetch(`${apiUrl}/api/media-direct/admin/finalize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ upload_token: init.upload_token }),
  })
  const result = await readMediaResponse(finalizeResponse, 'Cannot finish direct image upload')
  const imageUrl = result.image_url || result.imageUrl || ''
  const storageKey = result.path || result.storage_key || ''
  if (!imageUrl || !storageKey) {
    throw uploadError('Cloudflare returned an incomplete image reference', 503)
  }
  return {
    original_name: file.name,
    image_url: imageUrl,
    storage_key: storageKey,
  }
}

function uploadImagesThroughRender(apiUrl, token, files, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('images', file))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${apiUrl}/api/admin/media-library/upload`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.timeout = 300000

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total) {
        onProgress(Math.min(1, event.loaded / event.total))
      }
    })
    xhr.addEventListener('load', () => {
      let data = {}
      try {
        data = JSON.parse(xhr.responseText || '{}')
      } catch {
        data = {}
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) {
        const images = Array.isArray(data.images) ? data.images : []
        if (images.length === files.length && images.every((item) => item?.image_url && item?.storage_key)) {
          onProgress(1)
          resolve(images)
        } else {
          reject(uploadError('Existing upload service returned incomplete images'))
        }
      } else {
        reject(uploadError(data.message || 'Failed to upload images', xhr.status))
      }
    })
    xhr.addEventListener('error', () => reject(uploadError('Network error while uploading images')))
    xhr.addEventListener('timeout', () => reject(uploadError('Existing upload service timed out', 408)))
    xhr.addEventListener('abort', () => reject(uploadError('Image upload was canceled', 0, 'DIRECT_UPLOAD_CANCELED')))
    xhr.send(formData)
  })
}

function canUseDirectUpload(file) {
  return DIRECT_MEDIA_TYPES.has(file?.type) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 16 &&
    file.size <= DIRECT_MEDIA_MAX_BYTES
}

function canTryExistingService(error) {
  if (error?.code === 'DIRECT_UPLOAD_CANCELED') return false
  const status = Number(error?.status || 0)
  return ![400, 401, 403, 413, 415, 422, 429].includes(status)
}

export async function uploadMediaLibraryWithProgress({
  apiUrl,
  token,
  files,
}) {
  const selectedFiles = Array.from(files || [])
  const totalBytes = selectedFiles.reduce(
    (sum, file) => sum + Number(file?.size || 0),
    0
  )
  const view = createProgressView(selectedFiles.length, totalBytes)

  try {
    if (!selectedFiles.length) throw uploadError('Please choose at least one image')
    if (!token) throw uploadError('Please log in again before uploading images', 401)

    const results = new Array(selectedFiles.length)
    const pendingLegacy = []
    let completedBytes = 0
    let directEnabled = Date.now() >= directUnavailableUntil
    const baseUrl = String(apiUrl || '').replace(/\/+$/, '')

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index]
      if (!directEnabled || !canUseDirectUpload(file)) {
        pendingLegacy.push(index)
        continue
      }

      try {
        view.updateDirect(completedBytes, index + 1, selectedFiles.length, 'uploading')
        const uploaded = await uploadImageDirect(baseUrl, token, file, (uploadedBytes) => {
          view.updateDirect(completedBytes + uploadedBytes, index + 1, selectedFiles.length, 'uploading')
        })
        results[index] = uploaded
        completedBytes += file.size
        view.updateDirect(completedBytes, index + 1, selectedFiles.length, 'finalizing')
      } catch (error) {
        if (!canTryExistingService(error)) throw error
        directEnabled = false
        directUnavailableUntil = Date.now() + 60000
        pendingLegacy.push(index)
      }
    }

    if (pendingLegacy.length) {
      const legacyFiles = pendingLegacy.map((index) => selectedFiles[index])
      const legacyBytes = legacyFiles.reduce((sum, file) => sum + file.size, 0)
      view.updateDirect(completedBytes, selectedFiles.length - pendingLegacy.length, selectedFiles.length, 'fallback')
      const uploaded = await uploadImagesThroughRender(baseUrl, token, legacyFiles, (ratio) => {
        view.updateDirect(
          completedBytes + Math.round(legacyBytes * ratio),
          selectedFiles.length - pendingLegacy.length,
          selectedFiles.length,
          'fallback'
        )
      })
      pendingLegacy.forEach((index, offset) => {
        results[index] = uploaded[offset]
      })
    }

    if (results.some((item) => !item?.image_url || !item?.storage_key)) {
      throw uploadError('Some images could not be uploaded. Please try again.')
    }

    view.showSuccess()
    view.remove(900)
    return { ok: true, images: results }
  } catch (error) {
    view.showError(error?.message || 'Failed to upload images')
    view.remove(2200)
    throw error
  }
}
