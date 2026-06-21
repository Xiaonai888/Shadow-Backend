import React, { useEffect, useMemo, useState } from 'react'
import AdminLayout from '../components/AdminLayout'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const EMPTY_GENDER_SUMMARY = {
  total: 0,
  female: 0,
  male: 0,
  custom: 0,
  not_provided: 0,
}

function getAdminToken() {
  return sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token')
}

function formatDate(value) {
  if (!value) return '-'

  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTime(value) {
  if (!value) return '-'

  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString()
}

function formatAge(value) {
  if (!value) return '-'
  const birthDate = new Date(value)
  if (Number.isNaN(birthDate.getTime())) return '-'
  const today = new Date()
  let age = today.getFullYear() - birthDate.getFullYear()
  const monthDiff = today.getMonth() - birthDate.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age -= 1
  return `${age} years old`
}

function formatGender(gender, customGender) {
  if (gender === 'female') return 'Female'
  if (gender === 'male') return 'Male'
  if (gender === 'custom') return customGender || 'Custom'
  return '-'
}

function getInitial(name, username, email) {
  return String(name || username || email || 'U').trim().slice(0, 1).toUpperCase()
}

function normalizeStatus(status) {
  const value = String(status || 'active').toLowerCase()

  if (value === 'inactive') return 'Inactive'
  if (value === 'suspended') return 'Suspended'
  if (value === 'pending') return 'Pending'

  return 'Active'
}

function statusClass(status) {
  const value = String(status || 'active').toLowerCase()

  if (value === 'suspended') return 'suspended'
  if (value === 'pending') return 'pending'
  if (value === 'inactive') return 'inactive'

  return 'active'
}

function RoleBadge({ isAuthor }) {
  return (
    <span className={`community-role-badge ${isAuthor ? 'author' : 'reader'}`}>
      {isAuthor ? 'Author' : 'Reader'}
    </span>
  )
}

function StatusBadge({ status }) {
  return (
    <span className={`community-status-badge ${statusClass(status)}`}>
      {normalizeStatus(status)}
    </span>
  )
}

function VisitorStatusBadge({ visitor }) {
  return visitor.is_suspected_bot ? (
    <span className="community-visitor-badge bot">Suspected Bot</span>
  ) : (
    <span className="community-visitor-badge human">Human</span>
  )
}

function normalizeRiskLevel(value) {
  const risk = String(value || 'normal').toLowerCase()

  if (risk === 'low_risk') return 'Low Risk'
  if (risk === 'suspicious') return 'Suspicious'
  if (risk === 'likely_bot') return 'Likely Bot'
  if (risk === 'high_risk') return 'High Risk'

  return 'Normal'
}

function riskClass(value) {
  const risk = String(value || 'normal').toLowerCase()

  if (risk === 'low_risk') return 'low-risk'
  if (risk === 'suspicious') return 'suspicious'
  if (risk === 'likely_bot') return 'likely-bot'
  if (risk === 'high_risk') return 'high-risk'

  return 'normal'
}

function RiskBadge({ value }) {
  return (
    <span className={`community-risk-badge ${riskClass(value)}`}>
      {normalizeRiskLevel(value)}
    </span>
  )
}

function BotScoreBadge({ value }) {
  const score = Math.max(0, Math.min(100, Number(value || 0)))
  const tone = score >= 85 ? 'high' : score >= 70 ? 'likely' : score >= 50 ? 'suspicious' : score >= 30 ? 'low' : 'normal'

  return <span className={`community-score-badge ${tone}`}>{score}/100</span>
}

function Avatar({ name, username, email, avatarUrl, type, size = 'normal' }) {
  const [failed, setFailed] = useState(false)
  const showImage = avatarUrl && !failed

  return (
    <div className={`community-avatar ${type === 'author' ? 'author' : 'reader'} ${size === 'large' ? 'large' : ''}`}>
      {showImage ? (
        <img src={avatarUrl} alt={name || username || email || 'User'} onError={() => setFailed(true)} />
      ) : (
        getInitial(name, username, email)
      )}
    </div>
  )
}

function PersonCell({ name, username, email, avatarUrl, type }) {
  return (
    <div className="community-person">
      <Avatar name={name} username={username} email={email} avatarUrl={avatarUrl} type={type} />
      <div className="community-person-copy">
        <div className="community-name">{name || username || 'Unnamed'}</div>
        <div className="community-username">@{username || 'no_username'}</div>
      </div>
    </div>
  )
}

function EmptyState({ type }) {
  const isVisitors = type === 'visitors'
  const icon = type === 'authors' ? '✍' : isVisitors ? '◎' : '👥'

  return (
    <div className="community-empty-state">
      <div className="community-empty-icon">{icon}</div>
      <div className="community-empty-title">No {type} found</div>
      <div className="community-empty-text">
        {isVisitors ? 'No tracked visitor data matches this filter.' : 'Try changing your search keyword.'}
      </div>
    </div>
  )
}

function LoadingRows({ columns, label }) {
  return (
    <tr>
      <td colSpan={columns}>
        <div className="community-loading">
          <span className="community-spinner" />
          <span>{label}</span>
        </div>
      </td>
    </tr>
  )
}

async function copyToClipboard(value) {
  if (!value) return
  await navigator.clipboard?.writeText(String(value)).catch(() => {})
}

function DetailItem({ label, value }) {
  return (
    <div className="community-detail-item">
      <div className="community-detail-label">{label}</div>
      <div className="community-detail-value">{value || '-'}</div>
    </div>
  )
}

function UserDetailDrawer({ item, type, onClose }) {
  if (!item) return null

  const isAuthor = type === 'author'
  const name = isAuthor ? item.author_name : item.name
  const username = item.username
  const email = item.email
  const avatarUrl = item.avatar_url
  const status = item.status
  const joinedAt = item.joined_at
  const id = item.id
  const userId = item.user_id
  const dateOfBirth = item.date_of_birth
  const gender = item.gender
  const customGender = item.custom_gender

  return (
    <div className="community-drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside className="community-drawer" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="community-drawer-top">
          <div>
            <div className="community-drawer-kicker">{isAuthor ? 'Author Profile' : 'Reader Profile'}</div>
            <h3>{isAuthor ? 'Author details' : 'Reader details'}</h3>
          </div>
          <button type="button" className="community-drawer-close" onClick={onClose}>×</button>
        </div>

        <div className="community-drawer-profile">
          <Avatar name={name} username={username} email={email} avatarUrl={avatarUrl} type={isAuthor ? 'author' : 'reader'} size="large" />
          <div>
            <div className="community-drawer-name">{name || username || 'Unnamed'}</div>
            <div className="community-drawer-username">@{username || 'no_username'}</div>
            <div className="community-drawer-badges">
              {isAuthor ? <span className="community-role-badge author">Author</span> : <RoleBadge isAuthor={item.is_author} />}
              <StatusBadge status={status} />
            </div>
          </div>
        </div>

        <div className="community-drawer-actions">
          <button type="button" onClick={() => copyToClipboard(email)}>Copy Email</button>
          <button type="button" onClick={() => copyToClipboard(username ? `@${username}` : '')}>Copy Username</button>
          <button type="button" onClick={() => copyToClipboard(id)}>Copy {isAuthor ? 'Author ID' : 'User ID'}</button>
          {isAuthor ? <button type="button" onClick={() => copyToClipboard(userId)}>Copy User ID</button> : null}
        </div>

        <div className="community-detail-grid">
          <DetailItem label={isAuthor ? 'Author Name' : 'Reader Name'} value={name} />
          <DetailItem label="Username" value={username ? `@${username}` : '-'} />
          <DetailItem label="Email" value={email} />
          {!isAuthor ? <DetailItem label="Gender" value={formatGender(gender, customGender)} /> : null}
          {!isAuthor ? <DetailItem label="Age" value={formatAge(dateOfBirth)} /> : null}
          {isAuthor ? (
            <DetailItem label="Books" value={`${formatNumber(item.books_count)} books`} />
          ) : (
            <DetailItem label="Role" value={item.is_author ? 'Reader + Author' : 'Reader'} />
          )}
          <DetailItem label="Joined Date" value={formatDate(joinedAt)} />
          <DetailItem label="Status" value={normalizeStatus(status)} />
        </div>

        <div className="community-id-box">
          <div>
            <div className="community-id-label">{isAuthor ? 'Author ID' : 'User ID'}</div>
            <div className="community-id-value">{id}</div>
          </div>
          <button type="button" onClick={() => copyToClipboard(id)}>Copy</button>
        </div>

        {isAuthor ? (
          <div className="community-id-box">
            <div>
              <div className="community-id-label">User ID</div>
              <div className="community-id-value">{userId || '-'}</div>
            </div>
            <button type="button" onClick={() => copyToClipboard(userId)}>Copy</button>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

function VisitorDetailDrawer({ visitor, onClose }) {
  if (!visitor) return null

  return (
    <div className="community-drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside className="community-drawer visitor-drawer" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="community-drawer-top">
          <div>
            <div className="community-drawer-kicker">Anonymous Visitor</div>
            <h3>Visitor details</h3>
          </div>
          <button type="button" className="community-drawer-close" onClick={onClose}>×</button>
        </div>

        <div className="community-visitor-profile">
          <div className={`community-visitor-device-icon ${visitor.is_suspected_bot ? 'bot' : ''}`}>
            {visitor.is_suspected_bot ? '🤖' : visitor.device_type === 'Mobile' ? '▯' : visitor.device_type === 'Tablet' ? '▭' : '▣'}
          </div>
          <div>
            <div className="community-drawer-name">{visitor.device_type || 'Unknown device'}</div>
            <div className="community-drawer-username">
              {[visitor.browser, visitor.operating_system].filter(Boolean).join(' · ') || 'Unknown browser'}
            </div>
            <div className="community-drawer-badges">
              <VisitorStatusBadge visitor={visitor} />
              <RiskBadge value={visitor.risk_level} />
              <BotScoreBadge value={visitor.bot_score} />
              {visitor.country_code ? <span className="community-country-badge">{visitor.country_code}</span> : null}
            </div>
          </div>
        </div>

        <div className="community-drawer-actions">
          <button type="button" onClick={() => copyToClipboard(visitor.ip_address)}>Copy IP</button>
          <button type="button" onClick={() => copyToClipboard(visitor.visitor_id)}>Copy Visitor ID</button>
          <button type="button" onClick={() => copyToClipboard(visitor.session_id)}>Copy Session ID</button>
          <button type="button" onClick={() => copyToClipboard(visitor.cf_ray)}>Copy CF Ray</button>
        </div>

        <div className="community-detail-grid">
          <DetailItem label="IP Address" value={visitor.ip_address} />
          <DetailItem label="Device" value={visitor.device_type} />
          <DetailItem label="Browser" value={visitor.browser} />
          <DetailItem label="Operating System" value={visitor.operating_system} />
          <DetailItem label="Country" value={visitor.country_code} />
          <DetailItem label="Page Views" value={formatNumber(visitor.page_views)} />
          <DetailItem label="Bot Score" value={`${Number(visitor.bot_score || 0)}/100`} />
          <DetailItem label="Risk Level" value={normalizeRiskLevel(visitor.risk_level)} />
          <DetailItem label="Event Count" value={formatNumber(visitor.event_count)} />
          <DetailItem label="Rapid Repeats" value={formatNumber(visitor.rapid_repeat_count)} />
          <DetailItem label="WebDriver Detected" value={visitor.webdriver_detected ? 'Yes' : 'No'} />
          <DetailItem label="Last Risk Event" value={formatDateTime(visitor.last_event_at)} />
          <DetailItem label="First Path" value={visitor.first_path} />
          <DetailItem label="Last Path" value={visitor.last_path} />
          <DetailItem label="Referrer" value={visitor.referrer} />
          <DetailItem label="First Seen" value={formatDateTime(visitor.first_seen_at)} />
          <DetailItem label="Last Seen" value={formatDateTime(visitor.last_seen_at)} />
          <DetailItem label="Bot Reason" value={visitor.bot_reason} />
        </div>

        <div className="community-signal-box">
          <div className="community-id-label">Bot Signals</div>
          {Array.isArray(visitor.bot_signals) && visitor.bot_signals.length ? (
            <div className="community-signal-list">
              {visitor.bot_signals.map((signal, index) => (
                <div className="community-signal-item" key={`${signal.code || 'signal'}-${index}`}>
                  <div>
                    <strong>{signal.reason || signal.code || 'Risk signal'}</strong>
                    <span>{signal.code || 'unknown_signal'}</span>
                  </div>
                  <b>+{Number(signal.score || 0)}</b>
                </div>
              ))}
            </div>
          ) : (
            <div className="community-signal-empty">No bot signals recorded.</div>
          )}
        </div>

        <div className="community-id-box">
          <div>
            <div className="community-id-label">Visitor ID</div>
            <div className="community-id-value">{visitor.visitor_id || '-'}</div>
          </div>
          <button type="button" onClick={() => copyToClipboard(visitor.visitor_id)}>Copy</button>
        </div>

        <div className="community-id-box">
          <div>
            <div className="community-id-label">Session ID</div>
            <div className="community-id-value">{visitor.session_id || '-'}</div>
          </div>
          <button type="button" onClick={() => copyToClipboard(visitor.session_id)}>Copy</button>
        </div>

        <div className="community-id-box">
          <div>
            <div className="community-id-label">Cloudflare Ray ID</div>
            <div className="community-id-value">{visitor.cf_ray || '-'}</div>
          </div>
          <button type="button" onClick={() => copyToClipboard(visitor.cf_ray)}>Copy</button>
        </div>

        <div className="community-user-agent-box">
          <div className="community-id-label">User Agent</div>
          <div className="community-user-agent-value">{visitor.user_agent || '-'}</div>
          <button type="button" onClick={() => copyToClipboard(visitor.user_agent)}>Copy User Agent</button>
        </div>
      </aside>
    </div>
  )
}

async function readApiResponse(response) {
  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    const details = [data.message, data.error].filter(Boolean).join(' — ')
    throw new Error(details || `Request failed (${response.status})`)
  }

  return data
}

export default function AuthorsCommunity() {
  const [activeTab, setActiveTab] = useState('readers')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [visitorSummaryLoading, setVisitorSummaryLoading] = useState(true)
  const [listLoading, setListLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedItem, setSelectedItem] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filter, setFilter] = useState('all')
  const [summary, setSummary] = useState({
    total_readers: 0,
    total_authors: 0,
    total_community_members: 0,
    new_this_month: 0,
  })

  const [genderSummary, setGenderSummary] = useState(EMPTY_GENDER_SUMMARY)
  const [visitorSummary, setVisitorSummary] = useState({
    total_unique_visitors: 0,
    total_sessions: 0,
    visitors_today: 0,
    visitors_this_month: 0,
    active_last_10_minutes: 0,
    total_page_views: 0,
    suspected_bots: 0,
    normal_risk: 0,
    low_risk: 0,
    suspicious_risk: 0,
    likely_bot_risk: 0,
    high_risk: 0,
  })
  const [readers, setReaders] = useState([])
  const [authors, setAuthors] = useState([])
  const [visitors, setVisitors] = useState([])
  const [pagination, setPagination] = useState({
    page: 1,
    total: 0,
    total_pages: 1,
    has_next: false,
    has_prev: false,
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 350)

    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let alive = true

    async function loadSummary() {
      try {
        setSummaryLoading(true)
        const token = getAdminToken()
        const response = await fetch(`${API_URL}/api/admin/community/overview`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        const data = await readApiResponse(response)

        if (!alive) return
        setSummary(data.summary || {})
      } catch (err) {
        if (!alive) return
        setError(err.message || 'Failed to load community overview')
      } finally {
        if (alive) setSummaryLoading(false)
      }
    }

    loadSummary()

    return () => {
      alive = false
    }
  }, [refreshKey])

  useEffect(() => {
    let alive = true

    if (activeTab !== 'visitors') {
      setVisitorSummaryLoading(false)

      return () => {
        alive = false
      }
    }

    async function loadVisitorSummary() {
      try {
        setVisitorSummaryLoading(true)
        const token = getAdminToken()
        const response = await fetch(`${API_URL}/api/admin/community/visitors/overview`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        const data = await readApiResponse(response)

        if (!alive) return
        setVisitorSummary(data.summary || {})
      } catch (err) {
        if (!alive) return
        setError(err.message || 'Failed to load visitor overview')
      } finally {
        if (alive) setVisitorSummaryLoading(false)
      }
    }

    loadVisitorSummary()

    return () => {
      alive = false
    }
  }, [activeTab, refreshKey])

  useEffect(() => {
    let alive = true

    async function loadList() {
      try {
        setListLoading(true)
        setError('')

        const token = getAdminToken()
        const params = new URLSearchParams({
          page: String(page),
          limit: '20',
          filter,
        })

        if (debouncedSearch) params.set('q', debouncedSearch)

        const endpoint =
          activeTab === 'authors'
            ? 'authors'
            : activeTab === 'visitors'
              ? 'visitors'
              : 'readers'

        const response = await fetch(`${API_URL}/api/admin/community/${endpoint}?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        const data = await readApiResponse(response)

        if (!alive) return

        if (activeTab === 'authors') {
          setAuthors(Array.isArray(data.authors) ? data.authors : [])
        } else if (activeTab === 'visitors') {
          setVisitors(Array.isArray(data.visitors) ? data.visitors : [])
        } else {
          setReaders(Array.isArray(data.readers) ? data.readers : [])
          setGenderSummary(data.gender_summary || EMPTY_GENDER_SUMMARY)
        }

        setPagination({
          page: data.page || 1,
          total: data.total || 0,
          total_pages: data.total_pages || 1,
          has_next: Boolean(data.has_next),
          has_prev: Boolean(data.has_prev),
        })
      } catch (err) {
        if (!alive) return

        setError(err.message || 'Failed to load community data')

        if (activeTab === 'authors') setAuthors([])
        else if (activeTab === 'visitors') setVisitors([])
        else setReaders([])

        setPagination({
          page: 1,
          total: 0,
          total_pages: 1,
          has_next: false,
          has_prev: false,
        })
      } finally {
        if (alive) setListLoading(false)
      }
    }

    loadList()

    return () => {
      alive = false
    }
  }, [activeTab, page, debouncedSearch, filter, refreshKey])

  useEffect(() => {
    let refreshCount = 0

    const timer = window.setInterval(() => {
      if (document.hidden) return

      refreshCount += 1
      setRefreshKey((current) => current + 1)

      if (refreshCount >= 5) window.clearInterval(timer)
    }, 600000)

    return () => window.clearInterval(timer)
  }, [])

  function switchTab(tab) {
    setActiveTab(tab)
    setSearch('')
    setDebouncedSearch('')
    setPage(1)
    setFilter('all')
    setError('')
    setSelectedItem(null)
    setPagination({
      page: 1,
      total: 0,
      total_pages: 1,
      has_next: false,
      has_prev: false,
    })
  }

  const readerFilters = [
    { key: 'all', label: 'All' },
    { key: 'reader_only', label: 'Readers Only' },
    { key: 'authors', label: 'Authors' },
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
  ]

  const authorFilters = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
    { key: 'with_books', label: 'With Books' },
    { key: 'no_books', label: 'No Books' },
  ]

  const visitorFilters = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active 10 Min' },
    { key: 'today', label: 'Today' },
    { key: 'normal', label: 'Normal' },
    { key: 'low_risk', label: 'Low Risk' },
    { key: 'suspicious', label: 'Suspicious' },
    { key: 'likely_bot', label: 'Likely Bot' },
    { key: 'high_risk', label: 'High Risk' },
    { key: 'humans', label: 'Humans' },
    { key: 'bots', label: 'Suspected Bots' },
  ]

  const currentFilters =
    activeTab === 'authors'
      ? authorFilters
      : activeTab === 'visitors'
        ? visitorFilters
        : readerFilters

  const readerQuickStats = useMemo(() => {
    const readersOnly = readers.filter((reader) => !reader.is_author).length
    const authorReaders = readers.filter((reader) => reader.is_author).length
    const activeReaders = readers.filter((reader) => String(reader.status || 'active').toLowerCase() === 'active').length

    return [
      { label: 'Matched Readers', value: pagination.total || readers.length },
      { label: 'Readers Only', value: readersOnly },
      { label: 'Reader Authors', value: authorReaders },
      { label: 'Active Readers', value: activeReaders },
    ]
  }, [readers, pagination.total])

  const authorQuickStats = useMemo(() => {
    const withBooks = authors.filter((author) => Number(author.books_count || 0) > 0).length
    const noBooks = authors.filter((author) => Number(author.books_count || 0) <= 0).length
    const activeAuthors = authors.filter((author) => String(author.status || 'active').toLowerCase() === 'active').length

    return [
      { label: 'Matched Authors', value: pagination.total || authors.length },
      { label: 'With Books', value: withBooks },
      { label: 'No Books', value: noBooks },
      { label: 'Active Authors', value: activeAuthors },
    ]
  }, [authors, pagination.total])

  const visitorQuickStats = useMemo(() => [
    { label: 'Matched Sessions', value: pagination.total || visitors.length },
    { label: 'Normal Risk', value: visitorSummary.normal_risk },
    { label: 'Low Risk', value: visitorSummary.low_risk },
    {
      label: 'Suspicious or Higher',
      value:
        Number(visitorSummary.suspicious_risk || 0)
        + Number(visitorSummary.likely_bot_risk || 0)
        + Number(visitorSummary.high_risk || 0),
    },
    { label: 'Likely Bot', value: visitorSummary.likely_bot_risk },
    { label: 'High Risk', value: visitorSummary.high_risk },
  ], [pagination.total, visitorSummary, visitors.length])

  const quickStats =
    activeTab === 'authors'
      ? authorQuickStats
      : activeTab === 'visitors'
        ? visitorQuickStats
        : readerQuickStats

  const readerGenderStats = useMemo(() => {
    const female = Number(genderSummary.female || 0)
    const male = Number(genderSummary.male || 0)
    const custom = Number(genderSummary.custom || 0)
    const notProvided = Number(genderSummary.not_provided || 0)
    const total = Number(genderSummary.total || female + male + custom + notProvided)

    const femaleEnd = total ? (female / total) * 360 : 0
    const maleEnd = femaleEnd + (total ? (male / total) * 360 : 0)
    const customEnd = maleEnd + (total ? (custom / total) * 360 : 0)

    return {
      total,
      gradient: total
        ? `conic-gradient(#ec4899 0deg ${femaleEnd}deg, #3b82f6 ${femaleEnd}deg ${maleEnd}deg, #8b5cf6 ${maleEnd}deg ${customEnd}deg, #cbd5e1 ${customEnd}deg 360deg)`
        : '#eef2ff',
      items: [
        { label: 'Female', value: female, color: '#ec4899' },
        { label: 'Male', value: male, color: '#3b82f6' },
        { label: 'Custom/Other', value: custom, color: '#8b5cf6' },
        { label: 'Not Provided', value: notProvided, color: '#cbd5e1' },
      ],
    }
  }, [genderSummary])

  const communityCards = useMemo(() => [
    {
      label: 'Total Readers',
      value: summary.total_readers,
      icon: '👥',
      tone: 'blue',
      note: 'All registered accounts',
    },
    {
      label: 'Total Authors',
      value: summary.total_authors,
      icon: '✍',
      tone: 'purple',
      note: 'Accounts with author page',
    },
    {
      label: 'Community Members',
      value: summary.total_community_members || summary.total_members || summary.total_readers,
      icon: '◆',
      tone: 'dark',
      note: 'Unique users only',
    },
    {
      label: 'New This Month',
      value: summary.new_this_month,
      icon: '↗',
      tone: 'green',
      note: 'New reader accounts',
    },
  ], [summary])

  const visitorCards = useMemo(() => [
    {
      label: 'Unique Visitors',
      value: visitorSummary.total_unique_visitors,
      icon: '◎',
      tone: 'blue',
      note: 'Anonymous browser identities',
    },
    {
      label: 'Visitors Today',
      value: visitorSummary.visitors_today,
      icon: '◷',
      tone: 'purple',
      note: 'First seen today',
    },
    {
      label: 'Active 10 Minutes',
      value: visitorSummary.active_last_10_minutes,
      icon: '●',
      tone: 'green',
      note: 'Recently active visitors',
    },
    {
      label: 'Suspected Bots',
      value: visitorSummary.suspected_bots,
      icon: '⚠',
      tone: 'red',
      note: 'Review before blocking',
    },
  ], [visitorSummary])

  const cards = activeTab === 'visitors' ? visitorCards : communityCards
  const cardsLoading = activeTab === 'visitors' ? visitorSummaryLoading : summaryLoading

  const searchPlaceholder =
    activeTab === 'authors'
      ? 'Search author name, username, or email...'
      : activeTab === 'visitors'
        ? 'Search visitor ID, IP, device, browser, country, risk, or CF Ray...'
        : 'Search reader name, username, or email...'

  const currentTotal =
    activeTab === 'visitors'
      ? visitorSummary.total_unique_visitors
      : activeTab === 'authors'
        ? summary.total_authors
        : summary.total_readers

  const currentTotalLabel =
    activeTab === 'visitors'
      ? 'Unique visitors'
      : activeTab === 'authors'
        ? 'Authors shown'
        : 'Readers shown'

  return (
    <AdminLayout title="Community" subtitle="View readers, authors, and visitors in one place.">
      <style>{styles}</style>

      <div className="community-page">
        <section className="community-hero">
          <div>
            <div className="community-kicker">Community Overview</div>
            <h2>Readers, authors and visitors</h2>
            <p>Track registered users, author accounts, anonymous visitors, devices, IP addresses and suspected bots.</p>
          </div>
          <div className="community-hero-pill">
            <span>{formatNumber(currentTotal)}</span>
            <small>{currentTotalLabel}</small>
          </div>
        </section>

        <section className="community-cards">
          {cards.map((card) => (
            <div className="community-card" key={card.label}>
              <div className={`community-card-icon ${card.tone}`}>{card.icon}</div>
              <div className="community-card-copy">
                <div className="community-card-label">{card.label}</div>
                <div className="community-card-value">{cardsLoading ? '...' : formatNumber(card.value)}</div>
                <div className="community-card-note">{card.note}</div>
              </div>
            </div>
          ))}
        </section>

        <section className="community-panel">
          <div className="community-panel-top">
            <div className="community-tabs" role="tablist">
              <button type="button" className={activeTab === 'readers' ? 'active' : ''} onClick={() => switchTab('readers')}>Reader</button>
              <button type="button" className={activeTab === 'authors' ? 'active' : ''} onClick={() => switchTab('authors')}>Author</button>
              <button type="button" className={activeTab === 'visitors' ? 'active' : ''} onClick={() => switchTab('visitors')}>Visitor</button>
            </div>

            <div className="community-search-wrap">
              <span>⌕</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} />
            </div>
          </div>

          <div className="community-filter-row">
            {currentFilters.map((item) => (
              <button
                key={item.key}
                type="button"
                className={filter === item.key ? 'active' : ''}
                onClick={() => {
                  setFilter(item.key)
                  setPage(1)
                  setSelectedItem(null)
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="community-quick-stats">
            {quickStats.map((stat) => (
              <div className="community-quick-stat" key={stat.label}>
                <span>{stat.label}</span>
                <strong>{formatNumber(stat.value)}</strong>
              </div>
            ))}
          </div>

          {activeTab === 'readers' ? (
            <div className="community-gender-card">
              <div className="community-gender-copy">
                <h3>Reader Gender Breakdown</h3>
                <p>Overview of registered reader gender data.</p>
              </div>

              <div className="community-gender-chart-wrap">
                <div className="community-gender-donut" style={{ background: readerGenderStats.gradient }}>
                  <div>
                    <strong>{formatNumber(readerGenderStats.total)}</strong>
                    <span>Total</span>
                  </div>
                </div>

                <div className="community-gender-legend">
                  {readerGenderStats.items.map((item) => (
                    <div className="community-gender-legend-item" key={item.label}>
                      <span className="community-gender-dot" style={{ background: item.color }} />
                      <div>
                        <span>{item.label}</span>
                        <strong>{formatNumber(item.value)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="community-alert">
              <strong>Real API error:</strong> {error}
            </div>
          ) : null}

          {activeTab === 'visitors' ? (
            <div className="community-table-wrap">
              <table className="community-table visitor-table">
                <thead>
                  <tr>
                    <th>Visitor ID</th>
                    <th>IP Address</th>
                    <th>Device</th>
                    <th>Country</th>
                    <th>Views</th>
                    <th>Bot Score</th>
                    <th>Risk</th>
                    <th>Last Seen</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {listLoading ? (
                    <LoadingRows columns={10} label="Loading visitors..." />
                  ) : visitors.length ? visitors.map((visitor) => (
                    <tr key={visitor.id} className="community-clickable-row" onClick={() => setSelectedItem(visitor)}>
                      <td>
                        <div className="community-visitor-id-cell">
                          <strong>{visitor.visitor_id || '-'}</strong>
                          <span>{visitor.session_id || '-'}</span>
                        </div>
                      </td>
                      <td><span className="community-ip">{visitor.ip_address || '-'}</span></td>
                      <td>
                        <div className="community-device-cell">
                          <strong>{visitor.device_type || 'Unknown'}</strong>
                          <span>{[visitor.browser, visitor.operating_system].filter(Boolean).join(' · ') || '-'}</span>
                        </div>
                      </td>
                      <td><span className="community-country-badge">{visitor.country_code || '-'}</span></td>
                      <td>{formatNumber(visitor.page_views)}</td>
                      <td><BotScoreBadge value={visitor.bot_score} /></td>
                      <td><RiskBadge value={visitor.risk_level} /></td>
                      <td>{formatDateTime(visitor.last_seen_at)}</td>
                      <td><VisitorStatusBadge visitor={visitor} /></td>
                      <td>
                        <div className="community-table-actions">
                          <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedItem(visitor) }}>View</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); copyToClipboard(visitor.ip_address) }}>Copy IP</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); copyToClipboard(visitor.visitor_id) }}>Copy ID</button>
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan="10"><EmptyState type="visitors" /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : activeTab === 'readers' ? (
            <div className="community-table-wrap">
              <table className="community-table">
                <thead>
                  <tr>
                    <th>Reader</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined Date</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {listLoading ? (
                    <LoadingRows columns={6} label="Loading readers..." />
                  ) : readers.length ? readers.map((reader) => (
                    <tr key={reader.id} className="community-clickable-row" onClick={() => setSelectedItem(reader)}>
                      <td><PersonCell name={reader.name} username={reader.username} email={reader.email} avatarUrl={reader.avatar_url} type="reader" /></td>
                      <td><span className="community-email">{reader.email || '-'}</span></td>
                      <td><RoleBadge isAuthor={reader.is_author} /></td>
                      <td>{formatDate(reader.joined_at)}</td>
                      <td><StatusBadge status={reader.status} /></td>
                      <td>
                        <div className="community-table-actions">
                          <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedItem(reader) }}>View</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); copyToClipboard(reader.email) }}>Copy Email</button>
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan="6"><EmptyState type="readers" /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="community-table-wrap">
              <table className="community-table">
                <thead>
                  <tr>
                    <th>Author</th>
                    <th>Email</th>
                    <th>Books</th>
                    <th>Joined Date</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {listLoading ? (
                    <LoadingRows columns={6} label="Loading authors..." />
                  ) : authors.length ? authors.map((author) => (
                    <tr key={author.id} className="community-clickable-row" onClick={() => setSelectedItem(author)}>
                      <td><PersonCell name={author.author_name} username={author.username} email={author.email} avatarUrl={author.avatar_url} type="author" /></td>
                      <td><span className="community-email">{author.email || '-'}</span></td>
                      <td><span className="community-book-badge">{formatNumber(author.books_count)} books</span></td>
                      <td>{formatDate(author.joined_at)}</td>
                      <td><StatusBadge status={author.status} /></td>
                      <td>
                        <div className="community-table-actions">
                          <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedItem(author) }}>View</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); copyToClipboard(author.email) }}>Copy Email</button>
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan="6"><EmptyState type="authors" /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="community-pagination">
            <button type="button" disabled={!pagination.has_prev || listLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <span>Page {pagination.page} of {pagination.total_pages}</span>
            <button type="button" disabled={!pagination.has_next || listLoading} onClick={() => setPage((current) => current + 1)}>Next</button>
          </div>
        </section>
      </div>

      {activeTab === 'visitors' ? (
        <VisitorDetailDrawer visitor={selectedItem} onClose={() => setSelectedItem(null)} />
      ) : (
        <UserDetailDrawer item={selectedItem} type={activeTab === 'authors' ? 'author' : 'reader'} onClose={() => setSelectedItem(null)} />
      )}
    </AdminLayout>
  )
}

const styles = `
  .community-page { display: flex; flex-direction: column; gap: 18px; }
  .community-hero { background: linear-gradient(135deg, #FFFFFF, #F8FAFF); border: 1px solid #E2E8F0; border-radius: 22px; padding: 22px; display: flex; justify-content: space-between; align-items: center; gap: 16px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.045); }
  .community-kicker { color: #4F46E5; font-size: 11px; font-weight: 950; text-transform: uppercase; letter-spacing: 0.09em; margin-bottom: 8px; }
  .community-hero h2 { margin: 0; color: #0F172A; font-size: 25px; line-height: 1.15; font-weight: 950; letter-spacing: -0.04em; }
  .community-hero p { margin: 8px 0 0; color: #64748B; font-size: 13px; line-height: 1.55; font-weight: 750; max-width: 700px; }
  .community-hero-pill { min-width: 140px; min-height: 74px; border-radius: 18px; background: #FFFFFF; border: 1px solid #E2E8F0; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 8px 22px rgba(15, 23, 42, 0.05); }
  .community-hero-pill span { color: #4F46E5; font-size: 28px; font-weight: 950; line-height: 1; }
  .community-hero-pill small { color: #64748B; font-size: 11px; font-weight: 850; margin-top: 6px; }
  .community-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .community-card { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 18px; padding: 18px; display: flex; align-items: flex-start; gap: 13px; box-shadow: 0 8px 22px rgba(15, 23, 42, 0.04); transition: transform 0.16s ease, box-shadow 0.16s ease; }
  .community-card:hover { transform: translateY(-2px); box-shadow: 0 14px 30px rgba(15, 23, 42, 0.075); }
  .community-card-icon { width: 42px; height: 42px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 950; flex-shrink: 0; }
  .community-card-icon.blue { background: #EFF6FF; color: #2563EB; }
  .community-card-icon.purple { background: #EEF2FF; color: #4F46E5; }
  .community-card-icon.dark { background: #F1F5F9; color: #0F172A; }
  .community-card-icon.green { background: #ECFDF5; color: #059669; }
  .community-card-icon.red { background: #FEF2F2; color: #DC2626; }
  .community-card-copy { min-width: 0; }
  .community-card-label { color: #64748B; font-size: 12px; font-weight: 900; margin-bottom: 4px; }
  .community-card-value { color: #0F172A; font-size: 25px; font-weight: 950; letter-spacing: -0.04em; line-height: 1; }
  .community-card-note { color: #94A3B8; font-size: 11px; font-weight: 750; margin-top: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .community-panel { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 22px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.045); overflow: hidden; }
  .community-panel-top { padding: 16px; border-bottom: 1px solid #E2E8F0; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .community-tabs { background: #F8FAFC; border: 1px solid #D8E2EF; border-radius: 15px; padding: 4px; display: flex; gap: 4px; }
  .community-tabs button { border: 0; background: transparent; height: 36px; min-width: 92px; border-radius: 12px; padding: 0 18px; color: #64748B; font-size: 13px; font-weight: 950; cursor: pointer; transition: all 0.14s ease; }
  .community-tabs button.active { background: #4F46E5; color: #FFFFFF; box-shadow: 0 10px 20px rgba(79, 70, 229, 0.22); }
  .community-search-wrap { width: min(500px, 100%); height: 42px; border: 1px solid #D8E2EF; border-radius: 15px; display: flex; align-items: center; gap: 9px; padding: 0 13px; color: #94A3B8; background: #FFFFFF; transition: border-color 0.14s ease, box-shadow 0.14s ease; }
  .community-search-wrap:focus-within { border-color: #4F46E5; box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.08); }
  .community-search-wrap input { width: 100%; border: 0; outline: 0; font: inherit; font-size: 13px; font-weight: 800; color: #0F172A; background: transparent; }
  .community-search-wrap input::placeholder { color: #94A3B8; }
  .community-filter-row { padding: 12px 16px; border-bottom: 1px solid #EEF2F7; display: flex; gap: 8px; flex-wrap: wrap; background: #FFFFFF; }
  .community-filter-row button { height: 32px; border: 1px solid #E2E8F0; border-radius: 999px; background: #FFFFFF; color: #64748B; padding: 0 13px; font-size: 12px; font-weight: 900; cursor: pointer; transition: all 0.14s ease; }
  .community-filter-row button:hover { border-color: #4F46E5; color: #4F46E5; background: #F8FAFF; }
  .community-filter-row button.active { border-color: #4F46E5; background: #EEF2FF; color: #4F46E5; box-shadow: 0 8px 18px rgba(79, 70, 229, 0.12); }
  .community-quick-stats { padding: 14px 16px; border-bottom: 1px solid #EEF2F7; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; background: #FBFCFF; }
  .community-quick-stat { min-height: 58px; border: 1px solid #E2E8F0; border-radius: 15px; background: #FFFFFF; padding: 11px 13px; display: flex; flex-direction: column; justify-content: center; gap: 5px; }
  .community-quick-stat span { color: #64748B; font-size: 11px; font-weight: 900; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .community-quick-stat strong { color: #0F172A; font-size: 19px; font-weight: 950; letter-spacing: -0.03em; }
  .community-alert { margin: 16px; padding: 13px 15px; border-radius: 15px; background: #FEF2F2; color: #DC2626; font-size: 13px; font-weight: 850; word-break: break-word; }
  .community-table-wrap { width: 100%; overflow-x: auto; }
  .community-table { width: 100%; border-collapse: collapse; min-width: 840px; }
  .community-table.visitor-table { min-width: 1480px; }
  .community-table th { text-align: left; padding: 13px 16px; background: #F8FAFC; color: #64748B; font-size: 11px; font-weight: 950; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #E2E8F0; }
  .community-table td { padding: 15px 16px; border-bottom: 1px solid #EEF2F7; color: #334155; font-size: 13px; font-weight: 800; vertical-align: middle; }
  .community-table tbody tr { transition: background 0.14s ease; }
  .community-table tbody tr:hover { background: #F8FAFC; }
  .community-clickable-row { cursor: pointer; }
  .community-person { display: flex; align-items: center; gap: 12px; min-width: 240px; }
  .community-avatar { width: 42px; height: 42px; border-radius: 999px; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 950; flex-shrink: 0; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22); }
  .community-avatar.large { width: 58px; height: 58px; font-size: 18px; }
  .community-avatar.reader { background: linear-gradient(135deg, #4F46E5, #7C3AED); }
  .community-avatar.author { background: linear-gradient(135deg, #DB2777, #7C3AED); }
  .community-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .community-person-copy { min-width: 0; }
  .community-name { color: #0F172A; font-size: 13px; font-weight: 950; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .community-username { color: #64748B; font-size: 12px; font-weight: 750; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .community-email { color: #334155; font-size: 13px; font-weight: 800; }
  .community-role-badge, .community-status-badge, .community-book-badge, .community-visitor-badge, .community-country-badge, .community-risk-badge, .community-score-badge { display: inline-flex; align-items: center; justify-content: center; min-height: 26px; padding: 0 10px; border-radius: 999px; font-size: 11px; font-weight: 950; white-space: nowrap; }
  .community-role-badge.reader { background: #EFF6FF; color: #2563EB; }
  .community-role-badge.author { background: #FDF2F8; color: #DB2777; }
  .community-status-badge.active { background: #DCFCE7; color: #16A34A; }
  .community-status-badge.inactive { background: #F1F5F9; color: #64748B; }
  .community-status-badge.suspended { background: #FEE2E2; color: #DC2626; }
  .community-status-badge.pending { background: #FEF3C7; color: #B45309; }
  .community-book-badge { background: #EEF2FF; color: #4F46E5; }
  .community-visitor-badge.human { background: #DCFCE7; color: #15803D; }
  .community-visitor-badge.bot { background: #FEE2E2; color: #DC2626; }
  .community-risk-badge.normal { background: #ECFDF5; color: #047857; }
  .community-risk-badge.low-risk { background: #EFF6FF; color: #2563EB; }
  .community-risk-badge.suspicious { background: #FFF7ED; color: #C2410C; }
  .community-risk-badge.likely-bot { background: #FEF3C7; color: #A16207; }
  .community-risk-badge.high-risk { background: #FEE2E2; color: #B91C1C; }
  .community-score-badge.normal { background: #F1F5F9; color: #475569; }
  .community-score-badge.low { background: #DBEAFE; color: #1D4ED8; }
  .community-score-badge.suspicious { background: #FFEDD5; color: #C2410C; }
  .community-score-badge.likely { background: #FEF3C7; color: #A16207; }
  .community-score-badge.high { background: #FEE2E2; color: #B91C1C; }
  .community-country-badge { background: #F1F5F9; color: #334155; }
  .community-table-actions { display: flex; align-items: center; gap: 8px; }
  .community-table-actions button { height: 30px; border: 1px solid #E2E8F0; border-radius: 10px; background: #FFFFFF; color: #4F46E5; padding: 0 10px; font-size: 11px; font-weight: 950; cursor: pointer; white-space: nowrap; transition: all 0.14s ease; }
  .community-table-actions button:hover { border-color: #4F46E5; background: #EEF2FF; box-shadow: 0 8px 16px rgba(79, 70, 229, 0.12); }
  .community-loading { min-height: 86px; display: flex; align-items: center; justify-content: center; gap: 10px; color: #64748B; font-size: 13px; font-weight: 850; }
  .community-spinner { width: 18px; height: 18px; border-radius: 999px; border: 3px solid #E2E8F0; border-top-color: #4F46E5; animation: communitySpin 0.8s linear infinite; }
  .community-empty-state { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #64748B; }
  .community-empty-icon { width: 44px; height: 44px; border-radius: 16px; background: #F8FAFC; border: 1px solid #E2E8F0; display: flex; align-items: center; justify-content: center; color: #4F46E5; font-size: 17px; font-weight: 950; margin-bottom: 10px; }
  .community-empty-title { color: #0F172A; font-size: 14px; font-weight: 950; }
  .community-empty-text { color: #64748B; font-size: 12px; font-weight: 750; margin-top: 4px; }
  .community-pagination { padding: 14px 16px; display: flex; justify-content: flex-end; align-items: center; gap: 10px; color: #64748B; font-size: 12px; font-weight: 850; border-top: 1px solid #EEF2F7; }
  .community-pagination button { height: 34px; border: 1px solid #E2E8F0; background: #FFFFFF; border-radius: 12px; padding: 0 13px; color: #0F172A; font-size: 12px; font-weight: 900; cursor: pointer; }
  .community-pagination button:disabled { opacity: 0.45; cursor: not-allowed; }
  .community-visitor-id-cell, .community-device-cell { min-width: 190px; display: flex; flex-direction: column; gap: 4px; }
  .community-visitor-id-cell strong, .community-device-cell strong { color: #0F172A; font-size: 12px; font-weight: 950; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .community-visitor-id-cell span, .community-device-cell span { color: #94A3B8; font-size: 11px; font-weight: 750; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .community-ip { color: #0F172A; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 900; }
  .community-drawer-layer { position: fixed; inset: 0; z-index: 200; background: rgba(15, 23, 42, 0.34); display: flex; justify-content: flex-end; animation: communityFade 0.14s ease; }
  .community-drawer { width: min(430px, 100%); height: 100%; background: #FFFFFF; box-shadow: -18px 0 40px rgba(15, 23, 42, 0.18); padding: 22px; overflow-y: auto; animation: communitySlide 0.18s ease; }
  .community-drawer.visitor-drawer { width: min(520px, 100%); }
  .community-drawer-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
  .community-drawer-kicker { color: #4F46E5; font-size: 11px; font-weight: 950; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .community-drawer h3 { margin: 0; color: #0F172A; font-size: 22px; font-weight: 950; letter-spacing: -0.03em; }
  .community-drawer-close { width: 36px; height: 36px; border: 1px solid #E2E8F0; border-radius: 12px; background: #FFFFFF; color: #0F172A; font-size: 23px; line-height: 1; cursor: pointer; }
  .community-drawer-profile, .community-visitor-profile { border: 1px solid #E2E8F0; border-radius: 20px; padding: 16px; display: flex; align-items: center; gap: 14px; background: linear-gradient(135deg, #FFFFFF, #F8FAFF); margin-bottom: 16px; }
  .community-visitor-device-icon { width: 58px; height: 58px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: #EEF2FF; color: #4F46E5; font-size: 24px; font-weight: 950; flex-shrink: 0; }
  .community-visitor-device-icon.bot { background: #FEF2F2; color: #DC2626; }
  .community-drawer-name { color: #0F172A; font-size: 16px; font-weight: 950; }
  .community-drawer-username { color: #64748B; font-size: 12px; font-weight: 800; margin-top: 3px; }
  .community-drawer-badges { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .community-drawer-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-bottom: 16px; }
  .community-drawer-actions button { min-height: 38px; border: 1px solid #D8E2EF; border-radius: 13px; background: #FFFFFF; color: #4F46E5; font-size: 12px; font-weight: 950; cursor: pointer; transition: all 0.14s ease; }
  .community-drawer-actions button:hover { background: #EEF2FF; border-color: #4F46E5; box-shadow: 0 8px 18px rgba(79, 70, 229, 0.12); }
  .community-detail-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-bottom: 16px; }
  .community-detail-item { border: 1px solid #E2E8F0; border-radius: 16px; padding: 13px 14px; background: #FFFFFF; }
  .community-detail-label, .community-id-label { color: #64748B; font-size: 11px; font-weight: 950; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
  .community-detail-value { color: #0F172A; font-size: 13px; font-weight: 900; word-break: break-word; }
  .community-id-box { border: 1px solid #E2E8F0; border-radius: 16px; padding: 13px; background: #F8FAFC; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; margin-top: 10px; }
  .community-id-value { color: #0F172A; font-size: 12px; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .community-id-box button, .community-user-agent-box button { min-height: 32px; border: 1px solid #D8E2EF; border-radius: 11px; background: #FFFFFF; color: #4F46E5; font-size: 12px; font-weight: 950; padding: 0 12px; cursor: pointer; }
  .community-user-agent-box, .community-signal-box { border: 1px solid #E2E8F0; border-radius: 16px; padding: 13px; background: #F8FAFC; margin-top: 10px; }
  .community-signal-list { display: flex; flex-direction: column; gap: 8px; }
  .community-signal-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; border: 1px solid #E2E8F0; border-radius: 13px; padding: 10px 11px; background: #FFFFFF; }
  .community-signal-item strong { display: block; color: #0F172A; font-size: 12px; font-weight: 900; line-height: 1.4; }
  .community-signal-item span { display: block; color: #94A3B8; font-size: 10px; font-weight: 800; margin-top: 3px; word-break: break-word; }
  .community-signal-item b { color: #DC2626; font-size: 12px; font-weight: 950; }
  .community-signal-empty { color: #64748B; font-size: 12px; font-weight: 800; }
  .community-user-agent-value { color: #0F172A; font-size: 12px; font-weight: 800; line-height: 1.55; word-break: break-word; margin-bottom: 10px; }
  @keyframes communitySpin { to { transform: rotate(360deg); } }
  @keyframes communityFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes communitySlide { from { transform: translateX(30px); opacity: 0.6; } to { transform: translateX(0); opacity: 1; } }
  @media (max-width: 1080px) {
    .community-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .community-quick-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .community-hero { align-items: flex-start; flex-direction: column; }
    .community-hero-pill { width: 100%; }
    .community-cards { grid-template-columns: 1fr; }
    .community-panel-top { align-items: stretch; }
    .community-tabs, .community-search-wrap { width: 100%; }
    .community-tabs button { flex: 1; min-width: 0; padding: 0 8px; }
    .community-filter-row { overflow-x: auto; flex-wrap: nowrap; }
    .community-filter-row button { flex-shrink: 0; }
    .community-quick-stats { grid-template-columns: 1fr; }
    .community-drawer { width: 100%; }
    .community-drawer-actions { grid-template-columns: 1fr; }
  }

.community-gender-card {
  margin: 12px 18px 14px;
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-radius: 18px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.035);
}

.community-gender-copy h3 {
  margin: 0;
  color: #0F172A;
  font-size: 14px;
  font-weight: 950;
  letter-spacing: -0.02em;
}

.community-gender-copy p {
  margin: 4px 0 0;
  color: #64748B;
  font-size: 11px;
  font-weight: 750;
}

.community-gender-chart-wrap {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 520px;
}

.community-gender-donut {
  width: 70px;
  height: 70px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.community-gender-donut > div {
  width: 46px;
  height: 46px;
  border-radius: 999px;
  background: #FFFFFF;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.community-gender-donut strong {
  color: #0F172A;
  font-size: 13px;
  font-weight: 950;
  line-height: 1;
}

.community-gender-donut span {
  margin-top: 2px;
  color: #64748B;
  font-size: 9px;
  font-weight: 850;
}

.community-gender-legend {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.community-gender-legend-item {
  border: 1px solid #E2E8F0;
  border-radius: 12px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.community-gender-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex-shrink: 0;
}

.community-gender-legend-item span {
  display: block;
  color: #64748B;
  font-size: 10px;
  font-weight: 850;
  white-space: nowrap;
}

.community-gender-legend-item strong {
  display: block;
  margin-top: 2px;
  color: #0F172A;
  font-size: 14px;
  font-weight: 950;
}

@media (max-width: 900px) {
  .community-gender-card {
    align-items: flex-start;
    flex-direction: column;
  }

  .community-gender-chart-wrap {
    min-width: 0;
    width: 100%;
  }

  .community-gender-legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
`
