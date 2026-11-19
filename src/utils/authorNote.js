export const AUTHOR_NOTE_MAX_CHARACTERS = 500

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null

export function countAuthorNoteCharacters(value) {
  const text = String(value ?? '').normalize('NFC')
  if (!segmenter) return Array.from(text).length
  let count = 0
  for (const part of segmenter.segment(text)) {
    if (part.segment) count += 1
  }
  return count
}

export function validateAuthorNote(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    const error = new Error('Author note must be text.')
    error.code = 'AUTHOR_NOTE_INVALID'
    error.status = 400
    throw error
  }

  const note = value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (countAuthorNoteCharacters(note) > AUTHOR_NOTE_MAX_CHARACTERS) {
    const error = new Error('Author note cannot exceed 500 characters.')
    error.code = 'AUTHOR_NOTE_TOO_LONG'
    error.status = 400
    throw error
  }

  return note || null
}
