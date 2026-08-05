import {
  ChatUserSearchError,
  searchChatUsers,
} from '../services/chatUserSearch.service.js'

export async function searchChatUsersController(
  req,
  res
) {
  try {
    const users = await searchChatUsers({
      userId: req.user?.user_id,
      query: req.query?.q,
      limit: req.query?.limit,
    })

    return res.status(200).json({
      ok: true,
      users,
    })
  } catch (error) {
    console.error('SEARCH CHAT USERS ERROR', {
      message: error?.message || error,
      cause: error?.cause?.message || null,
    })

    if (error instanceof ChatUserSearchError) {
      return res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      })
    }

    return res.status(500).json({
      ok: false,
      code: 'CHAT_SEARCH_SERVER_ERROR',
      message: 'People search is temporarily unavailable',
    })
  }
}
