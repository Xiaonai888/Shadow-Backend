import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function clearReaderLibrary(req, res) {
  try {
    const userId = String(req.user?.user_id || req.user?.id || '').trim()
    if (!UUID_PATTERN.test(userId)) {
      return res.status(401).json({ ok: false, message: 'Authentication required' })
    }

    const { data, error } = await supabase.rpc('clear_reader_library_to_trash', {
      p_user_id: userId,
    })
    if (error) throw error

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      cleared_count: Math.max(0, Number(data || 0)),
    })
  } catch (error) {
    console.error('[READER_LIBRARY_BULK_CLEAR_ERROR]', error)
    return res.status(500).json({ ok: false, message: 'Failed to clear library' })
  }
}
