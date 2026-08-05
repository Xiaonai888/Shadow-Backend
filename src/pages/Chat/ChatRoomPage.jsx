import {
  Ban,
  Check,
  ChevronLeft,
  LoaderCircle,
  Send,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  useNavigate,
  useParams,
} from 'react-router-dom'
import {
  decideChatRequest,
  getChatMessages,
  hasReaderSession,
  markChatRead,
  sendChatMessage,
} from '../../services/chatApi'

function formatMessageTime(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function RoomAvatar({ person }) {
  const [failed, setFailed] = useState(false)
  const name = String(person?.name || 'Shadow').trim()
  const letter = name.charAt(0).toUpperCase() || 'S'

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111827] text-[13px] font-extrabold text-white">
      {person?.avatar_url && !failed ? (
        <img
          src={person.avatar_url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        letter
      )}
    </span>
  )
}

function RequestPanel({
  conversation,
  busyAction,
  onDecision,
}) {
  if (!conversation) return null

  if (conversation.request_status === 'pending') {
    if (conversation.can_decide) {
      return (
        <section className="mx-4 mt-4 rounded-[20px] border border-[#f0df86] bg-[#fff9dc] p-4">
          <h2 className="text-[13px] font-extrabold text-[#111827]">
            Message request
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-[#776b38]">
            Accept this request before continuing the conversation.
          </p>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => onDecision('accept')}
              disabled={Boolean(busyAction)}
              className="flex h-10 items-center justify-center gap-1 rounded-[12px] bg-[#111827] text-[10px] font-extrabold text-white disabled:opacity-50"
            >
              <Check size={15} />
              Accept
            </button>

            <button
              type="button"
              onClick={() => onDecision('decline')}
              disabled={Boolean(busyAction)}
              className="flex h-10 items-center justify-center gap-1 rounded-[12px] border border-[#d7d7dc] bg-white text-[10px] font-extrabold text-[#5c5c65] disabled:opacity-50"
            >
              <X size={15} />
              Decline
            </button>

            <button
              type="button"
              onClick={() => onDecision('block')}
              disabled={Boolean(busyAction)}
              className="flex h-10 items-center justify-center gap-1 rounded-[12px] border border-[#f0c8ca] bg-white text-[10px] font-extrabold text-[#c1353b] disabled:opacity-50"
            >
              <Ban size={14} />
              Block
            </button>
          </div>
        </section>
      )
    }

    return (
      <section className="mx-4 mt-4 rounded-[18px] bg-[#fff8d5] px-4 py-3 text-center">
        <p className="text-[11px] font-bold leading-5 text-[#78651a]">
          Waiting for the author to accept your message request.
        </p>
      </section>
    )
  }

  if (conversation.request_status === 'declined') {
    return (
      <section className="mx-4 mt-4 rounded-[18px] bg-[#f4f4f6] px-4 py-3 text-center">
        <p className="text-[11px] font-bold text-[#777781]">
          This message request was declined.
        </p>
      </section>
    )
  }

  if (conversation.request_status === 'blocked') {
    return (
      <section className="mx-4 mt-4 rounded-[18px] bg-[#fff0f1] px-4 py-3 text-center">
        <p className="text-[11px] font-bold text-[#bd3038]">
          Messaging is blocked for this conversation.
        </p>
      </section>
    )
  }

  return null
}

export default function ChatRoomPage() {
  const navigate = useNavigate()
  const { conversationId } = useParams()
  const bottomRef = useRef(null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')

  const loadRoom = useCallback(
    async ({ silent = false } = {}) => {
      if (!conversationId) return

      if (!silent) {
        setLoading(true)
      }

      try {
        const data = await getChatMessages(
          conversationId,
          { limit: 50 }
        )

        setConversation(data.conversation || null)
        setMessages(
          Array.isArray(data.messages)
            ? data.messages
            : []
        )
        setError('')

        if (
          Number(
            data.conversation?.unread_count || 0
          ) > 0
        ) {
          await markChatRead(conversationId)
        }
      } catch (loadError) {
        if (loadError.status === 401) {
          navigate('/login', { replace: true })
          return
        }

        if (
          loadError.status === 403 ||
          loadError.status === 404
        ) {
          setError(loadError.message)
          return
        }

        if (!silent) {
          setError(
            loadError.message ||
              'Failed to load conversation'
          )
        }
      } finally {
        setLoading(false)
      }
    },
    [conversationId, navigate]
  )

  useEffect(() => {
    if (!hasReaderSession()) {
      navigate('/login', { replace: true })
      return undefined
    }

    loadRoom()

    const intervalId = window.setInterval(() => {
      loadRoom({ silent: true })
    }, 3000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadRoom, navigate])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    })
  }, [messages.length])

  const handleSend = async () => {
    const message = text.trim()

    if (
      !message ||
      !conversation?.can_send ||
      sending
    ) {
      return
    }

    setSending(true)

    try {
      const data = await sendChatMessage(
        conversationId,
        message
      )

      setMessages((current) => [
        ...current,
        data.message,
      ])
      setText('')
      setError('')
    } catch (sendError) {
      setError(
        sendError.message || 'Failed to send message'
      )
    } finally {
      setSending(false)
    }
  }

  const handleDecision = async (action) => {
    if (busyAction) return

    if (
      action === 'block' &&
      !window.confirm(
        'Block this reader and stop all messages?'
      )
    ) {
      return
    }

    setBusyAction(action)

    try {
      const data = await decideChatRequest(
        conversationId,
        action
      )

      setConversation(data.conversation || null)
      setError('')
    } catch (decisionError) {
      setError(
        decisionError.message ||
          'Failed to update request'
      )
    } finally {
      setBusyAction('')
    }
  }

  const handleKeyDown = (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {
      event.preventDefault()
      handleSend()
    }
  }

  const person = conversation?.counterpart || {}
  const canSend = Boolean(conversation?.can_send)

  return (
    <div className="min-h-screen bg-[#f7f7f9]">
      <header className="sticky top-0 z-[80] border-b border-[#e9e9ed] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex h-[64px] max-w-[620px] items-center gap-3 px-3">
          <button
            type="button"
            onClick={() => navigate('/chat')}
            aria-label="Back to messages"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#111827] transition active:scale-90"
          >
            <ChevronLeft size={27} strokeWidth={2} />
          </button>

          <RoomAvatar person={person} />

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] font-extrabold text-[#111827]">
              {person.name || 'Conversation'}
            </h1>
            <p className="truncate text-[10px] font-semibold text-[#92929c]">
              {person.username
                ? `@${person.username}`
                : conversation?.request_status === 'accepted'
                  ? 'Messages'
                  : 'Message request'}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[620px] pb-[118px]">
        {error ? (
          <div className="mx-4 mt-4 rounded-[16px] bg-[#fff0f1] px-4 py-3 text-[11px] font-bold text-[#c7353d]">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-28 text-[#8c8c96]">
            <LoaderCircle
              size={28}
              className="animate-spin"
            />
          </div>
        ) : conversation ? (
          <>
            <RequestPanel
              conversation={conversation}
              busyAction={busyAction}
              onDecision={handleDecision}
            />

            <div className="space-y-3 px-4 py-5">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.is_mine
                      ? 'justify-end'
                      : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[82%] rounded-[20px] px-4 py-2.5 shadow-sm ${
                      message.is_mine
                        ? 'rounded-br-[6px] bg-[#f2c900] text-[#111827]'
                        : 'rounded-bl-[6px] bg-white text-[#24242c]'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-5">
                      {message.body}
                    </p>
                    <p
                      className={`mt-1 text-right text-[9px] font-semibold ${
                        message.is_mine
                          ? 'text-[#665500]'
                          : 'text-[#9b9ba4]'
                      }`}
                    >
                      {formatMessageTime(
                        message.created_at
                      )}
                    </p>
                  </div>
                </div>
              ))}

              <div ref={bottomRef} />
            </div>
          </>
        ) : null}
      </main>

      <div
        className="fixed bottom-0 left-0 right-0 z-[90] border-t border-[#e6e6ea] bg-white/95 backdrop-blur-xl"
        style={{
          paddingBottom:
            'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div className="mx-auto flex max-w-[620px] items-end gap-2 px-3 py-3">
          <textarea
            value={text}
            onChange={(event) =>
              setText(event.target.value.slice(0, 2000))
            }
            onKeyDown={handleKeyDown}
            disabled={!canSend || sending}
            rows={1}
            placeholder={
              canSend
                ? 'Write a message...'
                : conversation?.request_status === 'pending'
                  ? 'Waiting for request approval'
                  : 'Messages are unavailable'
            }
            className="max-h-28 min-h-[44px] flex-1 resize-none rounded-[22px] border border-[#dedee4] bg-[#f7f7f9] px-4 py-3 text-[13px] leading-5 text-[#111827] outline-none transition focus:border-[#ddbd00] focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={
              !canSend ||
              !text.trim() ||
              sending
            }
            aria-label="Send message"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f2c900] text-[#111827] transition active:scale-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {sending ? (
              <LoaderCircle
                size={19}
                className="animate-spin"
              />
            ) : (
              <Send size={19} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
