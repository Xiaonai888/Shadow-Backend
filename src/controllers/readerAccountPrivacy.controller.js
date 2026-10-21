import { supabase } from '../config/supabase.js'

export async function getReaderAccountPrivacy(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    const { data, error } = await supabase
      .from('users')
      .select('reader_posts_private')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Account not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, private: data.reader_posts_private === true })
  } catch (error) {
    console.error('GET READER PRIVACY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load account privacy' })
  }
}

export async function updateReaderAccountPrivacy(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    if (typeof req.body?.private !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'Private must be a boolean' })
    }
    const { data, error } = await supabase
      .from('users')
      .update({ reader_posts_private: req.body.private })
      .eq('id', userId)
      .eq('is_active', true)
      .select('reader_posts_private')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Account not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, private: data.reader_posts_private === true })
  } catch (error) {
    console.error('UPDATE READER PRIVACY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update account privacy' })
  }
}
