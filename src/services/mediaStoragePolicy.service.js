function clean(value) {
  return String(value ?? '').trim()
}

function getR2PublicBaseUrl() {
  return clean(process.env.R2_PUBLIC_URL).replace(/\/+$/, '')
}

function mediaPolicyError(field, reason) {
  const error = new Error(`${field}: ${reason}`)
  error.statusCode = 400
  error.code = 'INVALID_MEDIA_STORAGE'
  return error
}

function fieldName(path) {
  const input = clean(path)
  const match = input.match(/(?:^|\.)([^.[\]]+)(?:\[\d+\])?$/)
  return clean(match?.[1]).toLowerCase()
}

function hasMediaNoun(value) {
  return /(image|photo|avatar|cover|thumbnail|banner|media|audio|video|voice|music|screenshot|attachment|file|pdf|logo|icon|poster|background)/i.test(
    clean(value)
  )
}

function isStorageKeyField(value) {
  const input = clean(value).toLowerCase()
  return (
    input === 'storage_key' ||
    input === 'storagekey' ||
    input.endsWith('_storage_key') ||
    input.endsWith('storagekey')
  )
}

function isGenericLocatorField(value) {
  return new Set([
    'url',
    'urls',
    'uri',
    'src',
    'key',
    'keys',
    'path',
    'paths',
  ]).has(clean(value).toLowerCase())
}

function isMediaLocatorField(value, parentMediaContext = false) {
  const input = clean(value).toLowerCase()

  if (!input) return false
  if (isStorageKeyField(input)) return true

  if (parentMediaContext && isGenericLocatorField(input)) {
    return true
  }

  if (!hasMediaNoun(input)) return false

  if (
    /(?:^|_)(url|urls|uri|src|key|keys|path|paths|data|base64)$/.test(
      input
    )
  ) {
    return true
  }

  return new Set([
    'image',
    'images',
    'photo',
    'photos',
    'avatar',
    'cover',
    'thumbnail',
    'banner',
    'media',
    'audio',
    'video',
    'voice',
    'music',
    'screenshot',
    'attachment',
    'attachments',
    'file',
    'files',
    'pdf',
    'logo',
    'poster',
  ]).has(input)
}

export function isInlineMediaValue(value) {
  const input = clean(value).toLowerCase()

  return (
    input.startsWith('data:') ||
    input.startsWith('blob:') ||
    input.startsWith('base64,') ||
    input.includes(';base64,')
  )
}

export function isSupabaseStorageUrl(value) {
  const input = clean(value).toLowerCase()

  return (
    input.includes('supabase.co') &&
    input.includes('/storage/v1/object/')
  )
}

export function isR2PublicUrl(value) {
  const input = clean(value)
  const publicBase = getR2PublicBaseUrl()

  if (!input || !publicBase) return false

  return input === publicBase || input.startsWith(`${publicBase}/`)
}

export function isR2StorageKey(value) {
  const input = clean(value)

  if (!input) return false
  if (input.includes('://')) return false
  if (input.startsWith('data:')) return false
  if (input.startsWith('blob:')) return false
  if (input.includes('..')) return false

  return /^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(input)
}

export function assertR2StorageKey(
  value,
  { field = 'storage_key', allowEmpty = true } = {}
) {
  const input = clean(value)

  if (!input) {
    if (allowEmpty) return null
    throw mediaPolicyError(field, 'R2 storage key is required')
  }

  if (!isR2StorageKey(input)) {
    throw mediaPolicyError(field, 'invalid Cloudflare R2 storage key')
  }

  return input
}

export function assertR2MediaReference(
  value,
  {
    field = 'media',
    allowEmpty = true,
    allowStorageKey = false,
  } = {}
) {
  const input = clean(value)

  if (!input) {
    if (allowEmpty) return null
    throw mediaPolicyError(field, 'media file is required')
  }

  if (isInlineMediaValue(input)) {
    throw mediaPolicyError(
      field,
      'inline or Base64 media is not allowed; upload the file to Cloudflare R2 first'
    )
  }

  if (isSupabaseStorageUrl(input)) {
    throw mediaPolicyError(
      field,
      'Supabase Storage URLs are not allowed for new media'
    )
  }

  if (isR2PublicUrl(input)) {
    return input
  }

  if (allowStorageKey && isR2StorageKey(input)) {
    return input
  }

  throw mediaPolicyError(
    field,
    'media must use the configured Cloudflare R2 URL or storage key'
  )
}

export function assertR2MediaArray(
  values,
  {
    field = 'media',
    maxItems = 100,
    allowStorageKey = false,
  } = {}
) {
  if (!Array.isArray(values)) return []

  return values.slice(0, maxItems).map((value, index) =>
    assertR2MediaReference(value, {
      field: `${field}[${index}]`,
      allowEmpty: false,
      allowStorageKey,
    })
  )
}

export function findForbiddenMediaReferences(
  value,
  path = 'root',
  results = []
) {
  if (typeof value === 'string') {
    if (isInlineMediaValue(value) || isSupabaseStorageUrl(value)) {
      results.push({
        path,
        value,
      })
    }

    return results
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findForbiddenMediaReferences(item, `${path}[${index}]`, results)
    )

    return results
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      findForbiddenMediaReferences(item, `${path}.${key}`, results)
    )
  }

  return results
}

export function assertNoForbiddenMediaReferences(
  value,
  field = 'metadata'
) {
  const matches = findForbiddenMediaReferences(value)

  if (!matches.length) return value

  throw mediaPolicyError(
    field,
    `contains forbidden media at ${matches[0].path}`
  )
}

export function findInlineMediaReferences(
  value,
  path = 'root',
  results = []
) {
  if (typeof value === 'string') {
    if (isInlineMediaValue(value)) {
      results.push({ path, value })
    }

    return results
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findInlineMediaReferences(item, `${path}[${index}]`, results)
    )

    return results
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      findInlineMediaReferences(item, `${path}.${key}`, results)
    )
  }

  return results
}

export function assertNoInlineMediaReferences(
  value,
  field = 'request'
) {
  const matches = findInlineMediaReferences(value)

  if (!matches.length) return value

  throw mediaPolicyError(
    field,
    `inline or Base64 media is not allowed at ${matches[0].path}`
  )
}

export function findNonR2MediaReferences(
  value,
  path = 'root',
  results = [],
  parentMediaContext = false
) {
  if (!value || typeof value !== 'object') return results

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`

      if (typeof item === 'string' && parentMediaContext) {
        const input = clean(item)

        if (
          input &&
          !isR2PublicUrl(input) &&
          !isR2StorageKey(input)
        ) {
          results.push({ path: itemPath, value: item })
        }

        return
      }

      findNonR2MediaReferences(
        item,
        itemPath,
        results,
        parentMediaContext
      )
    })

    return results
  }

  Object.entries(value).forEach(([key, item]) => {
    const itemPath = `${path}.${key}`
    const currentField = fieldName(itemPath)
    const mediaContainer = hasMediaNoun(currentField)
    const locator = isMediaLocatorField(
      currentField,
      parentMediaContext
    )

    if (typeof item === 'string' && locator) {
      const input = clean(item)

      if (!input) return

      if (isStorageKeyField(currentField)) {
        if (!isR2StorageKey(input)) {
          results.push({ path: itemPath, value: item })
        }
        return
      }

      if (!isR2PublicUrl(input)) {
        results.push({ path: itemPath, value: item })
      }

      return
    }

    if (Array.isArray(item) && locator) {
      item.forEach((entry, index) => {
        if (typeof entry !== 'string') return

        const input = clean(entry)
        if (!input) return

        if (!isR2PublicUrl(input)) {
          results.push({
            path: `${itemPath}[${index}]`,
            value: entry,
          })
        }
      })
      return
    }

    findNonR2MediaReferences(
      item,
      itemPath,
      results,
      parentMediaContext || mediaContainer
    )
  })

  return results
}

export function assertNoNonR2MediaReferences(
  value,
  field = 'request'
) {
  const matches = findNonR2MediaReferences(value)

  if (!matches.length) return value

  throw mediaPolicyError(
    field,
    `media must use Cloudflare R2 at ${matches[0].path}`
  )
}

export function assertDiskBackedUploadFile(
  file,
  { field = 'file', allowEmpty = true } = {}
) {
  if (!file) {
    if (allowEmpty) return null
    throw mediaPolicyError(field, 'upload file is required')
  }

  if (
    Object.prototype.hasOwnProperty.call(file, 'buffer') ||
    Buffer.isBuffer(file.buffer)
  ) {
    throw mediaPolicyError(
      field,
      'RAM-backed upload buffers are not allowed'
    )
  }

  if (!clean(file.path)) {
    throw mediaPolicyError(
      field,
      'upload must use disk-backed temporary storage before R2'
    )
  }

  return file
}

export function assertDiskBackedUploadRequest(req) {
  const files = []

  if (req?.file) {
    files.push({ file: req.file, field: 'file' })
  }

  if (Array.isArray(req?.files)) {
    req.files.forEach((file, index) =>
      files.push({ file, field: `files[${index}]` })
    )
  } else if (req?.files && typeof req.files === 'object') {
    Object.entries(req.files).forEach(([key, values]) => {
      const list = Array.isArray(values) ? values : []

      list.forEach((file, index) =>
        files.push({ file, field: `files.${key}[${index}]` })
      )
    })
  }

  files.forEach(({ file, field }) =>
    assertDiskBackedUploadFile(file, { field, allowEmpty: false })
  )

  return req
}
