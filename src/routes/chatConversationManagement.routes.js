import express from 'express'
import { ChatServiceError } from '../services/chat.service.js'
import {
  archiveConversation,
  deleteConversationForUser,
  listManagedConversations,
  unarchiveConversation,
} from '../services/chatConversationManagement.service.js'

const router = express.Router()

function handleError(res, error, label) {
  console.error(label, {
    message: error?.message || error,
    cause: error?.cause?.message || null,
  })

  if (error instanceof ChatServiceError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
    })
  }

  return res.status(500).json({
    ok: false,
    code: 'CHAT_SERVER_ERROR',
    message: 'Chat is temporarily unavailable',
  })
}

router.get(
  '/conversations/managed',
  async (req, res) => {
    try {
      const conversations =
        await listManagedConversations({
          userId: req.user?.user_id,
          status: req.query?.status,
          view: req.query?.view,
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

router.patch(
  '/conversations/:conversationId/archive',
  async (req, res) => {
    try {
      const result = await archiveConversation({
        userId: req.user?.user_id,
        conversationId: req.params.conversationId,
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
  async (req, res) => {
    try {
      const result = await unarchiveConversation({
        userId: req.user?.user_id,
        conversationId: req.params.conversationId,
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
  async (req, res) => {
    try {
      const result = await deleteConversationForUser({
        userId: req.user?.user_id,
        conversationId: req.params.conversationId,
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
