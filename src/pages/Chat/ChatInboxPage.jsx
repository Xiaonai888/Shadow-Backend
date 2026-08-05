import {
  ChevronLeft,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import ReaderProfileFooter from '../../components/reader-profile/ReaderProfileFooter'
import {
  getChatConversations,
  hasReaderSession,
} from '../../services/chatApi'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Requests' },
  { key: 'accepted', label: 'Chats' },
]

function formatConversationTime(value) {
  if (!value) return ''

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)

  const wasYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  if (wasYesterday) return 'Yesterday'

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function Avatar({ person }) {
  const [failed, setFailed] = useState(false)
  const name = String(person?.name || 'Shadow').trim()
  const letter = name.charAt(0).toUpperCase() || 'S'

  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111827] text-[15px] font-extrabold text-white">
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

function ConversationStatus({ conversation }) {
  if (conversation.request_status !== 'pending') {
    return null
  }

  const label =
    conversation.viewer_role === 'author'
      ? 'Request'
      : 'Pending'

  return (
    <span className="rounded-full bg-[#fff4bf] px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.08em] text-[#7a5a00]">
      {label}
    </span>
  )
}

function EmptyInbox({ activeFilter }) {
  const isRequestFilter = activeFilter === 'pending'

  return (
    <div className="px-5 pt-16 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#fff6c9] text-[#111827]">
        <MessageCircle size={30} strokeWidth={1.9} />
      </div>
      <h2 className="mt-5 text-[18px] font-extrabold text-[#111827]">
        {isRequestFilter
          ? 'No message requests'
          : 'No messages yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-6 text-[#8b8b95]">
        {isRequestFilter
          ? 'New reader-to-author requests will appear here.'
          : 'Conversations with readers and authors will appear here.'}
      </p>
    </div>
  )
}

export default function ChatInboxPage() {
  const navigate = useNavigate()
  const [conversations, setConversations] = useState([])
  const [activeFilter, setActiveFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadConversations = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }

      try {
        const data = await getChatConversations('all')
        setConversations(
          Array.isArray(data.conversations)
            ? data.conversations
            : []
        )
        setError('')
      } catch (loadError) {
        if (loadError.status === 401) {
          navigate('/login', { replace: true })
          return
        }

        setError(
          loadError.message || 'Failed to load messages'
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [navigate]
  )

  useEffect(() => {
    if (!hasReaderSession()) {
      navigate('/login', { replace: true })
      return undefined
    }

    loadConversations()

    const intervalId = window.setInterval(() => {
      loadConversations({ silent: true })
    }, 6000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadConversations, navigate])

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return conversations.filter((conversation) => {
      if (
        activeFilter !== 'all' &&
        conversation.request_status !== activeFilter
      ) {
        return false
      }

      if (!normalizedQuery) return true

      const person = conversation.counterpart || {}
      const searchable = [
        person.name,
        person.username,
        conversation.latest_message?.body,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchable.includes(normalizedQuery)
    })
  }, [activeFilter, conversations, query])

  const unreadTotal = useMemo(
    () =>
      conversations.reduce(
        (total, item) =>
          total + Number(item.unread_count || 0),
        0
      ),
    [conversations]
  )

  return (
    <div className="min-h-screen bg-white pb-[88px]">
      <header className="sticky top-0 z-[70] border-b border-[#ededf1] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto max-w-[620px] px-4 pb-4 pt-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => navigate('/profile')}
              aria-label="Back to profile"
              className="flex h-10 w-10 items-center justify-center rounded-full text-[#111827] transition active:scale-90"
            >
              <ChevronLeft size={27} strokeWidth={2} />
            </button>

            <div className="text-center">
              <h1 className="text-[18px] font-extrabold text-[#111827]">
                Messages
              </h1>
              {unreadTotal > 0 ? (
                <p className="mt-0.5 text-[10px] font-bold text-[#a57500]">
                  {unreadTotal} unread
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() =>
                loadConversations({ silent: true })
              }
              disabled={refreshing}
              aria-label="Refresh messages"
              className="flex h-10 w-10 items-center justify-center rounded-full text-[#111827] transition active:scale-90 disabled:opacity-50"
            >
              <RefreshCw
                size={20}
                className={refreshing ? 'animate-spin' : ''}
              />
            </button>
          </div>

          <div className="relative mt-3">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#9b9ba4]"
            />
            <input
              value={query}
              onChange={(event) =>
                setQuery(event.target.value)
              }
              placeholder="Search messages"
              className="h-11 w-full rounded-full border border-[#e8e8ed] bg-[#f7f7f9] pl-11 pr-4 text-[13px] font-medium text-[#111827] outline-none transition focus:border-[#e2bd00] focus:bg-white"
            />
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto">
            {FILTERS.map((filter) => {
              const active = filter.key === activeFilter

              return (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() =>
                    setActiveFilter(filter.key)
                  }
                  className={`shrink-0 rounded-full px-4 py-2 text-[11px] font-extrabold transition ${
                    active
                      ? 'bg-[#111827] text-white'
                      : 'bg-[#f1f1f4] text-[#71717a]'
                  }`}
                >
                  {filter.label}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[620px]">
        {error ? (
          <div className="mx-4 mt-4 rounded-[16px] bg-[#fff1f1] px-4 py-3 text-[12px] font-bold text-[#cf3038]">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-[#8b8b95]">
            <LoaderCircle
              size={26}
              className="animate-spin"
            />
          </div>
        ) : visibleConversations.length ? (
          <div className="divide-y divide-[#f0f0f3]">
            {visibleConversations.map((conversation) => {
              const person = conversation.counterpart || {}
              const latest = conversation.latest_message
              const unread = Number(
                conversation.unread_count || 0
              )

              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() =>
                    navigate(`/chat/${conversation.id}`)
                  }
                  className="flex w-full items-center gap-3 px-4 py-4 text-left transition hover:bg-[#fafafa] active:bg-[#f5f5f5]"
                >
                  <Avatar person={person} />

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <strong className="truncate text-[14px] font-extrabold text-[#111827]">
                        {person.name || 'Shadow User'}
                      </strong>
                      <ConversationStatus
                        conversation={conversation}
                      />
                    </span>

                    <span
                      className={`mt-1 block truncate text-[12px] ${
                        unread > 0
                          ? 'font-bold text-[#30303a]'
                          : 'font-medium text-[#8b8b95]'
                      }`}
                    >
                      {latest?.body ||
                        'Open this conversation'}
                    </span>
                  </span>

                  <span className="flex shrink-0 flex-col items-end gap-2">
                    <span className="text-[10px] font-semibold text-[#9b9ba4]">
                      {formatConversationTime(
                        conversation.last_message_at ||
                          latest?.created_at
                      )}
                    </span>

                    {unread > 0 ? (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f2c900] px-1.5 text-[9px] font-black text-[#111827]">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <EmptyInbox activeFilter={activeFilter} />
        )}
      </main>

      <ReaderProfileFooter />
    </div>
  )
}
