import { supabase } from '../config/supabase.js'

export async function getAuthorPageTransparency(req, res) {
  const username = String(req.params.pageUsername || '').trim().replace(/^@+/, '').toLowerCase()
  if (!/^[a-z0-9_]{3,}$/.test(username)) {
    return res.status(400).json({ ok: false, message: 'Invalid page username' })
  }

  try {
    const { data: page, error: pageError } = await supabase
      .from('author_pages')
      .select('id, created_at')
      .eq('page_username', username)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError
    if (!page) return res.status(404).json({ ok: false, message: 'Author page not found' })

    const { data: history, error: historyError } = await supabase
      .from('author_page_name_history')
      .select('old_name, new_name, changed_at')
      .eq('author_page_id', page.id)
      .order('changed_at', { ascending: false })
      .order('id', { ascending: false })

    if (historyError) throw historyError
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({
      ok: true,
      page_created_at: page.created_at,
      name_change_count: history.length,
      name_changes: history,
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE TRANSPARENCY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load page transparency' })
  }
}
