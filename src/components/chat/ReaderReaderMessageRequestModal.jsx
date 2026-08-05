import {
  LoaderCircle,
  Send,
  X,
} from 'lucide-react'
import {
  useEffect,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createReaderReaderMessageRequest,
  getChatConversations,
} from '../../services/chatApi'

function ReaderAvatar({ reader }) {
  const [failed, setFailed] = useState(false)
  const name =
    reader?.name ||
    reader?.username ||
    'Reader'
  const letter =
    String(name).trim().charAt(0).toUpperCase() ||
    'R'
  const avatarUrl =
    reader?.avatar_url ||
    reader?.avatarUrl ||
    ''

  return (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111827] text-[17px] font-extrabold text-white">
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
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

export default function ReaderReaderMessageRequestModal({
  open,
  reader,
  onClose,
}) {
  const navigate = useNavigate()
  const [message, setMessage] = useState('')
  const [checking, setChecking] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined

    const previousOverflow =
      document.body.style.overflow
    const previousTouchAction =
      document.body.style.touchAction

    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.touchAction =
        previousTouchAction
    }
  }, [open])

  useEffect(() => {
    if (!open || !reader?.id) return undefined

    let ignore = false

    async function checkExistingConversation() {
      setMessage('')
      setError('')
      setChecking(true)

      try {
        const data =
          await getChatConversations('all')
        const conversations =
          Array.isArray(data.conversations)
            ? data.conversations
            : []

        const existing = conversations.find(
          (item) =>
            item.conversation_type ===
              'reader_reader' &&
            String(
              item.counterpart?.user_id || ''
            ) === String(reader.id)
        )

        if (!ignore && existing?.id) {
          onClose?.()
          navigate(`/chat/${existing.id}`)
          return
        }
      } catch (checkError) {
        if (!ignore) {
          setError(
            checkError.message ||
              'Failed to check conversation'
          )
        }
      } finally {
        if (!ignore) {
          setChecking(false)
        }
      }
    }

    checkExistingConversation()

    return () => {
      ignore = true
    }
  }, [navigate, onClose, open, reader?.id])

  if (!open) return null

  const readerName =
    reader?.name ||
    reader?.username ||
    'Reader'

  const handleSubmit = async () => {
    const text = message.trim()

    if (
      !text ||
      !reader?.id ||
      checking ||
      sending
    ) {
      return
    }

    try {
      setSending(true)
      setError('')

      const data =
        await createReaderReaderMessageRequest({
          readerUserId: reader.id,
          message: text,
        })

      const conversationId =
        data.conversation?.id

      if (!conversationId) {
        throw new Error(
          'Conversation was not created'
        )
      }

      window.dispatchEvent(
        new CustomEvent('shadow-chat-updated')
      )
      onClose?.()
      navigate(`/chat/${conversationId}`)
    } catch (sendError) {
      setError(
        sendError.message ||
          'Failed to send message request'
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[320] flex items-end justify-center md:items-center md:px-4">
      <button
        type="button"
        aria-label="Close message request"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      <section className="relative w-full rounded-t-[28px] bg-white px-4 pb-[calc(20px+env(safe-area-inset-bottom,0px))] pt-3 shadow-2xl md:max-w-[430px] md:rounded-[26px] md:px-5 md:pb-5">
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-[#d6d4dc] md:hidden" />

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ReaderAvatar reader={reader} />

            <div className="min-w-0">
              <div className="text-[11px] font-bold text-[#8a8792]">
                Message request
              </div>
              <h2 className="mt-0.5 truncate text-[17px] font-extrabold text-[#111827]">
                {readerName}
              </h2>
              <div className="mt-0.5 truncate text-[11px] font-semibold text-[#8a8792]">
                {reader?.username
                  ? `@${reader.username}`
                  : 'Reader profile'}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f3f2f6] text-[#55515e] transition active:scale-90"
          >
            <X size={20} />
          </button>
        </div>

        {checking ? (
          <div className="flex min-h-[190px] items-center justify-center text-[#7c3aed]">
            <LoaderCircle
              size={27}
              className="animate-spin"
            />
          </div>
        ) : (
          <>
            <div className="mt-5 rounded-[16px] bg-[#f6f2ff] px-4 py-3 text-[11px] font-semibold leading-5 text-[#6d5a91]">
              You can send one message request. More messages become available after this reader accepts it.
            </div>

            {error ? (
              <div className="mt-3 rounded-[14px] bg-[#fff0f1] px-4 py-3 text-[11px] font-bold text-[#c7353d]">
                {error}
              </div>
            ) : null}

            <div className="mt-4">
              <textarea
                value={message}
                onChange={(event) =>
                  setMessage(
                    event.target.value.slice(
                      0,
                      2000
                    )
                  )
                }
                rows={5}
                autoFocus
                placeholder={`Write a message to ${readerName}...`}
                className="min-h-[130px] w-full resize-none rounded-[18px] border border-[#ddd9e6] bg-[#faf9fc] px-4 py-3 text-[13px] leading-6 text-[#111827] outline-none transition placeholder:text-[#9a96a2] focus:border-[#9b7be8] focus:bg-white"
              />

              <div className="mt-1 text-right text-[10px] font-semibold text-[#9a96a2]">
                {message.length}/2000
              </div>
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!message.trim() || sending}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-gradient-to-r from-[#7c3aed] to-[#a78bfa] text-[13px] font-extrabold text-white shadow-[0_8px_20px_rgba(124,58,237,0.22)] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {sending ? (
                <LoaderCircle
                  size={18}
                  className="animate-spin"
                />
              ) : (
                <Send
                  size={17}
                  strokeWidth={2.2}
                />
              )}
              Send request
            </button>
          </>
        )}
      </section>
    </div>
  )
}
