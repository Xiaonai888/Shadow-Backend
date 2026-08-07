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

  return (
    input === publicBase ||
    input.startsWith(`${publicBase}/`)
  )
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
    if (
      isInlineMediaValue(value) ||
      isSupabaseStorageUrl(value)
    ) {
      results.push({
        path,
        value,
      })
    }

    return results
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findForbiddenMediaReferences(
        item,
        `${path}[${index}]`,
        results
      )
    )

    return results
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      findForbiddenMediaReferences(
        item,
        `${path}.${key}`,
        results
      )
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
