import express from 'express'
import {
  ChatServiceError,
} from '../services/chat.service.js'
import {
  addConversationToFolder,
  archiveConversation,
  clearConversationHistory,
  createChatFolder,
  deleteConversation,
  getConversationAutoDeleteStatus,
  getConversationMuteStatus,
  getConversationSoundSettings,
  listChatFolders,
  listManagedConversations,
  markConversationUnread,
  muteConversation,
  pinConversation,
  removeConversationFromFolder,
  setConversationAutoDelete,
  setConversationSoundSettings,
  unarchiveConversation,
  unmuteConversation,
  unpinConversation,
} from '../services/chatConversationManagement.service.js'
import {
  createSpamGuard,
} from '../middleware/spamGuard.middleware.js'

const router = express.Router()

const conversationReadGuard =
  createSpamGuard({
    scope:
      'chat_conversation_management_read',
    threshold: 120,
    windowSeconds: 60,
  })

const conversationWriteGuard =
  createSpamGuard({
    scope:
      'chat_conversation_management_write',
    threshold: 30,
    windowSeconds: 60,
  })

function handleError(
  res,
  error,
  label
) {
  console.error(label, {
    message:
      error?.message || error,
    cause:
      error?.cause?.message || null,
  })

  if (
    error instanceof
    ChatServiceError
  ) {
    return res
      .status(error.status)
      .json({
        ok: false,
        code: error.code,
        message: error.message,
      })
  }

  return res.status(500).json({
    ok: false,
    code: 'CHAT_SERVER_ERROR',
    message:
      'Chat is temporarily unavailable',
  })
}

router.get(
  '/folders',
  conversationReadGuard,
  async (req, res) => {
    try {
      const folders = await listChatFolders({
  userId: req.user?.user_id,
  conversationId:
    req.query?.conversation_id,
})

      return res.status(200).json({
        ok: true,
        folders,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'LIST CHAT FOLDERS ERROR'
      )
    }
  }
)

router.post(
  '/folders',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const folder = await createChatFolder({
        userId: req.user?.user_id,
        name: req.body?.name,
      })

      return res.status(201).json({
        ok: true,
        folder,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'CREATE CHAT FOLDER ERROR'
      )
    }
  }
)

router.patch(
  '/folders/:folderId/conversations/:conversationId',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await addConversationToFolder({
          userId: req.user?.user_id,
          folderId: req.params.folderId,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'ADD CHAT TO FOLDER ERROR'
      )
    }
  }
)

router.delete(
  '/folders/:folderId/conversations/:conversationId',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await removeConversationFromFolder({
          userId: req.user?.user_id,
          folderId: req.params.folderId,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'REMOVE CHAT FROM FOLDER ERROR'
      )
    }
  }
)


router.get(
  '/conversations/managed',
  conversationReadGuard,
  async (req, res) => {
    try {
      const conversations =
        await listManagedConversations({
          userId:
            req.user?.user_id,
          status:
            req.query?.status,
          view:
            req.query?.view,
        })

      return res.status(200).json({
        ok: true,
        conversations,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'LIST MANAGED CHAT CONVERSATIONS ERROR'
      )
    }
  }
)

router.get(
  '/conversations/:conversationId/mute',
  conversationReadGuard,
  async (req, res) => {
    try {
      const result =
        await getConversationMuteStatus({
          userId:
            req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'GET CHAT MUTE STATUS ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/mute',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await muteConversation({
          userId:
            req.user?.user_id,
          conversationId:
            req.params.conversationId,
          duration:
            req.body?.duration ||
            'forever',
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'MUTE CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.delete(
  '/conversations/:conversationId/mute',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await unmuteConversation({
          userId:
            req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'UNMUTE CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.get(
  '/conversations/:conversationId/sound',
  conversationReadGuard,
  async (req, res) => {
    try {
      const result =
        await getConversationSoundSettings({
          userId: req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'GET CHAT SOUND SETTINGS ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/sound',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await setConversationSoundSettings({
          userId: req.user?.user_id,
          conversationId:
            req.params.conversationId,
          soundEnabled:
            req.body?.sound_enabled,
          tone: req.body?.tone,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'UPDATE CHAT SOUND SETTINGS ERROR'
      )
    }
  }
)


router.get(
  '/conversations/:conversationId/auto-delete',
  conversationReadGuard,
  async (req, res) => {
    try {
      const result =
        await getConversationAutoDeleteStatus({
          userId:
            req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'GET CHAT AUTO DELETE STATUS ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/auto-delete',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await setConversationAutoDelete({
          userId:
            req.user?.user_id,
          conversationId:
            req.params.conversationId,
          seconds:
            req.body?.seconds,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'UPDATE CHAT AUTO DELETE ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/clear-history',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await clearConversationHistory({
          userId: req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'CLEAR CHAT HISTORY ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/unread',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await markConversationUnread({
          userId: req.user?.user_id,
          conversationId:
            req.params.conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'MARK CHAT UNREAD ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/pin',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result = await pinConversation({
        userId: req.user?.user_id,
        conversationId:
          req.params.conversationId,
      })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'PIN CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.delete(
  '/conversations/:conversationId/pin',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result = await unpinConversation({
        userId: req.user?.user_id,
        conversationId:
          req.params.conversationId,
      })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'UNPIN CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.patch(
  '/conversations/:conversationId/archive',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await archiveConversation({
          userId:
            req.user?.user_id,
          conversationId:
            req.params
              .conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'ARCHIVE CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.delete(
  '/conversations/:conversationId/archive',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await unarchiveConversation({
          userId:
            req.user?.user_id,
          conversationId:
            req.params
              .conversationId,
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'UNARCHIVE CHAT CONVERSATION ERROR'
      )
    }
  }
)

router.delete(
  '/conversations/:conversationId',
  conversationWriteGuard,
  async (req, res) => {
    try {
      const result =
        await deleteConversation({
          userId:
            req.user?.user_id,
          conversationId:
            req.params
              .conversationId,
          scope:
            req.body?.scope ||
            req.query?.scope ||
            'for_me',
        })

      return res.status(200).json({
        ok: true,
        ...result,
      })
    } catch (error) {
      return handleError(
        res,
        error,
        'DELETE CHAT CONVERSATION ERROR'
      )
    }
  }
)

export default router
