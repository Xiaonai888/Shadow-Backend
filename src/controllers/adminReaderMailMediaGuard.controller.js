import { supabase } from '../config/supabase.js'
import {
  assertR2MediaReference,
} from '../services/mediaStoragePolicy.service.js'
import {
  sendReaderMailToAll as sendReaderMailToAllOriginal,
  sendReaderMailToOne as sendReaderMailToOneOriginal,
  updateAdminReaderMail as updateAdminReaderMailOriginal,
} from './adminReaderMails.controller.js'

function clean(value) {
  return String(value ?? '').trim()
}

function safeMailImage(value, currentValue = '') {
  const input = clean(value)
  const current = clean(currentValue)

  if (!input) return ''
  if (input === current) return input

  return assertR2MediaReference(input, {
    field: 'reader_mails.image_url',
    allowEmpty: false,
  })
}

function sendGuardError(res, error) {
  return res.status(error?.statusCode || 400).json({
    ok: false,
    code: error?.code || 'INVALID_MEDIA_STORAGE',
    message: error?.message || 'Invalid reader mail image',
  })
}

export async function sendReaderMailToOne(req, res) {
  try {
    req.body.image_url = safeMailImage(req.body?.image_url)
    return sendReaderMailToOneOriginal(req, res)
  } catch (error) {
    return sendGuardError(res, error)
  }
}

export async function sendReaderMailToAll(req, res) {
  try {
    req.body.image_url = safeMailImage(req.body?.image_url)
    return sendReaderMailToAllOriginal(req, res)
  } catch (error) {
    return sendGuardError(res, error)
  }
}

export async function updateAdminReaderMail(req, res) {
  try {
    const mailId = clean(req.params.mailId)
    let currentImageUrl = ''

    if (mailId) {
      const { data, error } = await supabase
        .from('reader_mails')
        .select('image_url')
        .eq('id', mailId)
        .is('deleted_at', null)
        .maybeSingle()

      if (error) throw error
      currentImageUrl = data?.image_url || ''
    }

    req.body.image_url = safeMailImage(
      req.body?.image_url,
      currentImageUrl
    )

    return updateAdminReaderMailOriginal(req, res)
  } catch (error) {
    if (error?.statusCode || error?.code === 'INVALID_MEDIA_STORAGE') {
      return sendGuardError(res, error)
    }

    console.error('READER MAIL MEDIA GUARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to validate reader mail image',
      error: error?.message || '',
    })
  }
}
