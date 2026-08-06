import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
}

function getUserId(req) {
  return String(req.user?.user_id || '').trim()
}

async function getAuthorPage(pageUsername) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username')
    .eq('page_username', pageUsername)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getBlockStatus(readerUserId, authorPage) {
  const [
    pageBlockResult,
    accountBlockResult,
  ] = await Promise.all([
    supabase
      .from('reader_blocked_author_pages')
      .select('id')
      .eq('reader_user_id', readerUserId)
      .eq('author_page_id', authorPage.id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('chat_blocks')
      .select('id')
      .eq('blocker_user_id', readerUserId)
      .eq('blocked_user_id', authorPage.user_id)
      .limit(1)
      .maybeSingle(),
  ])

  if (pageBlockResult.error) {
    throw pageBlockResult.error
  }

  if (accountBlockResult.error) {
    throw accountBlockResult.error
  }

  const pageBlocked = Boolean(pageBlockResult.data)
  const accountBlocked = Boolean(accountBlockResult.data)

  return {
    is_blocked: pageBlocked || accountBlocked,
    page_blocked: pageBlocked,
    account_blocked: accountBlocked,
  }
}

async function insertBlock(table, payload) {
  const { data, error } = await supabase
    .from(table)
    .insert(payload)
    .select('id')
    .maybeSingle()

  if (error && error.code !== '23505') {
    throw error
  }

  return {
    inserted: Boolean(data) && !error,
    id: data?.id || null,
  }
}

export async function getReaderAuthorPageBlockStatus(req, res) {
  try {
    const readerUserId = getUserId(req)
    const pageUsername = cleanText(req.params.pageUsername)

    if (!readerUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Page username is required',
      })
    }

    const authorPage = await getAuthorPage(pageUsername)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const blockStatus = await getBlockStatus(
      readerUserId,
      authorPage
    )

    return res.status(200).json({
      ok: true,
      block_status: blockStatus,
    })
  } catch (error) {
    console.error(
      'GET READER AUTHOR PAGE BLOCK STATUS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load block status',
      error: error.message,
    })
  }
}

export async function blockReaderAuthorPage(req, res) {
  let insertedPageBlockId = null

  try {
    const readerUserId = getUserId(req)
    const pageUsername = cleanText(req.params.pageUsername)

    if (!readerUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Page username is required',
      })
    }

    const authorPage = await getAuthorPage(pageUsername)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    if (
      String(authorPage.user_id) ===
      String(readerUserId)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'You cannot block your own page',
      })
    }

    const pageBlock = await insertBlock(
      'reader_blocked_author_pages',
      {
        reader_user_id: readerUserId,
        author_page_id: authorPage.id,
      }
    )

    insertedPageBlockId = pageBlock.inserted
      ? pageBlock.id
      : null

    await insertBlock('chat_blocks', {
      blocker_user_id: readerUserId,
      blocked_user_id: authorPage.user_id,
    })

    const blockStatus = await getBlockStatus(
      readerUserId,
      authorPage
    )

    return res.status(200).json({
      ok: true,
      message: `${authorPage.page_name || 'Author Page'} blocked`,
      block_status: blockStatus,
    })
  } catch (error) {
    if (insertedPageBlockId) {
      await supabase
        .from('reader_blocked_author_pages')
        .delete()
        .eq('id', insertedPageBlockId)
    }

    console.error(
      'BLOCK READER AUTHOR PAGE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to block Author Page',
      error: error.message,
    })
  }
}

export async function unblockReaderAuthorPage(req, res) {
  try {
    const readerUserId = getUserId(req)
    const pageUsername = cleanText(req.params.pageUsername)

    if (!readerUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Page username is required',
      })
    }

    const authorPage = await getAuthorPage(pageUsername)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const [
      pageDeleteResult,
      accountDeleteResult,
    ] = await Promise.all([
      supabase
        .from('reader_blocked_author_pages')
        .delete()
        .eq('reader_user_id', readerUserId)
        .eq('author_page_id', authorPage.id),
      supabase
        .from('chat_blocks')
        .delete()
        .eq('blocker_user_id', readerUserId)
        .eq('blocked_user_id', authorPage.user_id),
    ])

    if (pageDeleteResult.error) {
      throw pageDeleteResult.error
    }

    if (accountDeleteResult.error) {
      throw accountDeleteResult.error
    }

    return res.status(200).json({
      ok: true,
      message: `${authorPage.page_name || 'Author Page'} unblocked`,
      block_status: {
        is_blocked: false,
        page_blocked: false,
        account_blocked: false,
      },
    })
  } catch (error) {
    console.error(
      'UNBLOCK READER AUTHOR PAGE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to unblock Author Page',
      error: error.message,
    })
  }
}
