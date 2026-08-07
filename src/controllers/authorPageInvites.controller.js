import { supabase } from '../config/supabase.js'
import { createNotification } from './notifications.controller.js'

function normalizePageUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase()
}

export async function inviteAuthorPageFriend(req, res) {
  try {
    const inviterUserId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const targetUserId = String(req.body.target_user_id || '').trim()

    if (!inviterUserId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername || !targetUserId) {
      return res.status(400).json({ ok: false, message: 'Author Page and friend are required' })
    }

    if (String(inviterUserId) === targetUserId) {
      return res.status(400).json({ ok: false, message: 'You cannot invite yourself' })
    }

    const [
      { data: authorPage, error: pageError },
      { data: inviter, error: inviterError },
      { data: targetUser, error: targetError },
    ] = await Promise.all([
      supabase
        .from('author_pages')
        .select('id, page_name, page_username, cover_url')
        .eq('page_username', pageUsername)
        .eq('status', 'active')
        .maybeSingle(),
      supabase
        .from('users')
        .select('id, name, username')
        .eq('id', inviterUserId)
        .eq('is_active', true)
        .maybeSingle(),
      supabase
        .from('users')
        .select('id, name, username')
        .eq('id', targetUserId)
        .eq('is_active', true)
        .maybeSingle(),
    ])

    if (pageError) throw pageError
    if (inviterError) throw inviterError
    if (targetError) throw targetError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author Page not found' })
    }

    if (!inviter || !targetUser) {
      return res.status(404).json({ ok: false, message: 'Reader not found' })
    }

    const { data: friendFollow, error: friendError } = await supabase
      .from('user_follows')
      .select('id')
      .eq('follower_user_id', inviterUserId)
      .eq('following_user_id', targetUserId)
      .maybeSingle()

    if (friendError) throw friendError

    if (!friendFollow) {
      return res.status(403).json({ ok: false, message: 'You can only invite readers you follow' })
    }

    const { data: pageFollow, error: pageFollowError } = await supabase
      .from('author_page_follows')
      .select('id')
      .eq('author_page_id', authorPage.id)
      .eq('follower_user_id', targetUserId)
      .maybeSingle()

    if (pageFollowError) throw pageFollowError

    if (pageFollow) {
      return res.status(200).json({
        ok: true,
        status: 'following',
        message: 'This reader already follows the Page',
      })
    }

    const referenceId = `author-page-invite:${authorPage.id}:${inviterUserId}`
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: recentInvite, error: recentInviteError } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', targetUserId)
      .eq('reference_id', referenceId)
      .is('deleted_at', null)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (recentInviteError) throw recentInviteError

    if (recentInvite) {
      return res.status(200).json({
        ok: true,
        status: 'invited',
        message: 'Invite already sent recently',
      })
    }

    const inviterName = String(inviter.name || inviter.username || 'A friend').trim()
    const notification = await createNotification({
      userId: targetUserId,
      type: 'announcements',
      title: 'Author Page invitation',
      message: `${inviterName} invited you to follow ${authorPage.page_name}.`,
      imageUrl: authorPage.cover_url || '',
      link: `/author/page/${authorPage.page_username}`,
      referenceId,
    })

    if (!notification) {
      return res.status(500).json({ ok: false, message: 'Failed to send invite' })
    }

    return res.status(200).json({
      ok: true,
      status: 'invited',
      message: 'Invite sent',
      notification,
    })
  } catch (error) {
    console.error('INVITE AUTHOR PAGE FRIEND ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to send invite',
      error: error.message,
    })
  }
}
