import { createHash } from 'node:crypto'

const GOOGLE_TRANSLATE_URL =
  'https://translation.googleapis.com/language/translate/v2'

const SUPPORTED_TARGET_LANGUAGES = new Set([
  'km',
  'en',
  'zh',
  'ja',
  'ko',
])

const MAX_CONTENT_LENGTH = 30000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const REQUEST_TIMEOUT_MS = 20000

const translationCache = new Map()

export class StoryTranslationError extends Error {
  constructor(message, statusCode = 500, code = 'TRANSLATION_FAILED') {
    super(message)
    this.name = 'StoryTranslationError'
    this.statusCode = statusCode
    this.code = code
  }
}

function normalizeTargetLanguage(value) {
  return String(value || '').trim().toLowerCase()
}

function hasRichMarkup(value) {
  return /<(?:p|div|br|strong|b|em|i|img)\b/i.test(String(value || ''))
}

function buildCacheKey(content, targetLanguage) {
  return createHash('sha256')
    .update(`${targetLanguage}\n${content}`)
    .digest('hex')
}

function getCachedTranslation(cacheKey) {
  const cached = translationCache.get(cacheKey)

  if (!cached) return null

  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    translationCache.delete(cacheKey)
    return null
  }

  return cached.translatedContent
}

function saveCachedTranslation(cacheKey, translatedContent) {
  translationCache.set(cacheKey, {
    translatedContent,
    createdAt: Date.now(),
  })

  while (translationCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = translationCache.keys().next().value
    if (!oldestKey) break
    translationCache.delete(oldestKey)
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export async function translateStoryContent({
  content,
  targetLanguage,
}) {
  const source = String(content || '')
  const target = normalizeTargetLanguage(targetLanguage)

  if (!source.trim()) {
    throw new StoryTranslationError(
      'Story content is required',
      400,
      'CONTENT_REQUIRED'
    )
  }

  if (source.length > MAX_CONTENT_LENGTH) {
    throw new StoryTranslationError(
      `Story content cannot exceed ${MAX_CONTENT_LENGTH} characters`,
      413,
      'CONTENT_TOO_LARGE'
    )
  }

  if (!SUPPORTED_TARGET_LANGUAGES.has(target)) {
    throw new StoryTranslationError(
      'Unsupported target language',
      400,
      'UNSUPPORTED_LANGUAGE'
    )
  }

  const apiKey = String(
    process.env.GOOGLE_TRANSLATE_API_KEY || ''
  ).trim()

  if (!apiKey) {
    throw new StoryTranslationError(
      'Translation service is not configured',
      503,
      'TRANSLATION_NOT_CONFIGURED'
    )
  }

  const cacheKey = buildCacheKey(source, target)
  const cachedTranslation = getCachedTranslation(cacheKey)

  if (cachedTranslation !== null) {
    return {
      translatedContent: cachedTranslation,
      cached: true,
    }
  }

  const format = hasRichMarkup(source) ? 'html' : 'text'
  const abortController = new AbortController()
  const timeout = setTimeout(
    () => abortController.abort(),
    REQUEST_TIMEOUT_MS
  )

  try {
    const response = await fetch(
      `${GOOGLE_TRANSLATE_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: source,
          target,
          format,
        }),
        signal: abortController.signal,
      }
    )

    const data = await response.json().catch(() => ({}))
    const translatedText =
      data?.data?.translations?.[0]?.translatedText

    if (!response.ok || typeof translatedText !== 'string') {
      throw new StoryTranslationError(
        'Translation provider request failed',
        502,
        'TRANSLATION_PROVIDER_FAILED'
      )
    }

    const translatedContent =
      format === 'text'
        ? decodeHtmlEntities(translatedText)
        : translatedText

    saveCachedTranslation(cacheKey, translatedContent)

    return {
      translatedContent,
      cached: false,
    }
  } catch (error) {
    if (error instanceof StoryTranslationError) {
      throw error
    }

    if (error?.name === 'AbortError') {
      throw new StoryTranslationError(
        'Translation request timed out',
        504,
        'TRANSLATION_TIMEOUT'
      )
    }

    throw new StoryTranslationError(
      'Translation provider is unavailable',
      502,
      'TRANSLATION_PROVIDER_UNAVAILABLE'
    )
  } finally {
    clearTimeout(timeout)
  }
}
