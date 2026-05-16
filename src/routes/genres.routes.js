import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'

function getAdminToken() {
  return sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token')
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function Icon({ d, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ minWidth: size, flexShrink: 0 }}
    >
      <path d={d} />
    </svg>
  )
}

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

  :root {
    --bg:#F8FAFC;
    --card:#FFFFFF;
    --text:#0F172A;
    --muted:#64748B;
    --soft:#94A3B8;
    --border:#E2E8F0;
    --primary:#4F46E5;
    --primaryLight:#EEF2FF;
    --dark:#0F172A;
    --success:#16A34A;
    --successBg:#DCFCE7;
    --danger:#EF4444;
    --dangerBg:#FEE2E2;
    --warning:#F59E0B;
    --warningBg:#FEF3C7;
    --side:80px;
    --sideOpen:260px;
  }

  * {
    box-sizing:border-box;
  }

  body {
    margin:0;
    background:var(--bg);
    font-family:Inter, sans-serif;
    color:var(--text);
  }

  .genre-admin-shell {
    min-height:100vh;
    height:100vh;
    display:flex;
    background:var(--bg);
    overflow:hidden;
  }

  .genre-sidebar {
    width:var(--side);
    background:#fff;
    border-right:1px solid var(--border);
    padding:20px 14px;
    overflow-y:auto;
    overflow-x:hidden;
    transition:.25s ease;
    flex-shrink:0;
    z-index:20;
  }

  .genre-sidebar:hover {
    width:var(--sideOpen);
    box-shadow:10px 0 30px rgba(15,23,42,.06);
  }

  .genre-sidebar::-webkit-scrollbar {
    width:0;
  }

  .genre-logo {
    height:40px;
    display:flex;
    align-items:center;
    gap:12px;
    margin-bottom:28px;
    padding-left:10px;
    color:var(--primary);
  }

  .genre-logo-text {
    opacity:0;
    white-space:nowrap;
    color:var(--primary);
    font-weight:900;
    font-size:18px;
    transition:.2s;
  }

  .genre-sidebar:hover .genre-logo-text,
  .genre-sidebar:hover .genre-nav-text,
  .genre-sidebar:hover .genre-nav-label {
    opacity:1;
  }

  .genre-nav-label {
    opacity:0;
    display:block;
    margin:18px 0 8px 12px;
    font-size:10px;
    font-weight:900;
    text-transform:uppercase;
    letter-spacing:1px;
    color:var(--soft);
    white-space:nowrap;
    transition:.2s;
  }

  .genre-nav-item {
    height:44px;
    display:flex;
    align-items:center;
    border-radius:12px;
    padding:0 12px;
    color:var(--muted);
    cursor:pointer;
    margin-bottom:2px;
    font-weight:650;
    white-space:nowrap;
    transition:.18s ease;
  }

  .genre-nav-item:hover,
  .genre-nav-item.active {
    background:var(--primaryLight);
    color:var(--primary);
    transform:translateX(2px);
  }

  .genre-nav-text {
    opacity:0;
    margin-left:14px;
    transition:.2s;
  }

  .genre-main {
    flex:1;
    overflow:auto;
  }

  .genre-header {
    height:70px;
    background:#fff;
    border-bottom:1px solid var(--border);
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:0 36px;
    position:sticky;
    top:0;
    z-index:10;
  }

  .genre-header h2 {
    font-size:17px;
    font-weight:900;
    margin:0;
  }

  .genre-content {
    padding:28px 36px 50px;
    max-width:1600px;
    margin:0 auto;
    animation:genreFade .28s ease;
  }

  @keyframes genreFade {
    from {
      opacity:0;
      transform:translateY(8px);
    }
    to {
      opacity:1;
      transform:translateY(0);
    }
  }

  .genre-page-top {
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap:18px;
    margin-bottom:22px;
  }

  .genre-page-top h1 {
    margin:0;
    font-size:28px;
    font-weight:950;
    letter-spacing:-.05em;
  }

  .genre-page-top p {
    margin:6px 0 0;
    color:var(--muted);
    font-size:13.5px;
    font-weight:600;
  }

  .genre-primary-btn,
  .genre-dark-btn,
  .genre-ghost-btn,
  .genre-danger-btn {
    border:0;
    border-radius:13px;
    height:42px;
    padding:0 16px;
    font-weight:900;
    cursor:pointer;
    transition:.18s ease;
    white-space:nowrap;
  }

  .genre-primary-btn {
    background:var(--primary);
    color:#fff;
    box-shadow:0 10px 24px rgba(79,70,229,.22);
  }

  .genre-dark-btn {
    background:var(--dark);
    color:#fff;
  }

  .genre-ghost-btn {
    background:#fff;
    color:var(--text);
    border:1px solid var(--border);
  }

  .genre-danger-btn {
    background:#fff;
    color:var(--danger);
    border:1px solid #FECACA;
  }

  .genre-primary-btn:hover,
  .genre-dark-btn:hover,
  .genre-ghost-btn:hover,
  .genre-danger-btn:hover {
    transform:translateY(-2px);
  }

  .genre-primary-btn:disabled,
  .genre-dark-btn:disabled,
  .genre-ghost-btn:disabled,
  .genre-danger-btn:disabled {
    opacity:.55;
    cursor:not-allowed;
    transform:none;
  }

  .genre-stat-grid {
    display:grid;
    grid-template-columns:repeat(4, minmax(0, 1fr));
    gap:14px;
    margin-bottom:18px;
  }

  .genre-stat-card {
    background:#fff;
    border:1px solid var(--border);
    border-radius:18px;
    padding:18px;
    transition:.2s ease;
  }

  .genre-stat-card:hover {
    transform:translateY(-2px);
    box-shadow:0 14px 36px rgba(15,23,42,.07);
  }

  .genre-stat-label {
    color:var(--muted);
    font-size:12px;
    font-weight:900;
    text-transform:uppercase;
    letter-spacing:.06em;
  }

  .genre-stat-value {
    margin-top:10px;
    font-size:28px;
    font-weight:950;
    letter-spacing:-.04em;
  }

  .genre-stat-note {
    margin-top:5px;
    color:var(--soft);
    font-size:12.5px;
    font-weight:700;
  }

  .genre-control-grid {
    display:grid;
    grid-template-columns:repeat(2, minmax(0, 1fr));
    gap:18px;
    align-items:stretch;
    margin-bottom:18px;
  }

  .genre-control-grid .genre-card {
    height:100%;
  }

  .genre-stack {
    display:grid;
    gap:18px;
  }

  .genre-card {
    background:#fff;
    border:1px solid var(--border);
    border-radius:20px;
    overflow:hidden;
    box-shadow:0 1px 2px rgba(15,23,42,.03);
    transition:.2s ease;
  }

  .genre-card:hover {
    box-shadow:0 12px 34px rgba(15,23,42,.06);
  }

  .genre-card-head {
    padding:18px 20px;
    border-bottom:1px solid var(--border);
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
  }

  .genre-card-head h3 {
    margin:0;
    font-size:17px;
    font-weight:950;
    letter-spacing:-.03em;
  }

  .genre-card-head p {
    margin:4px 0 0;
    color:var(--muted);
    font-size:12.5px;
    font-weight:650;
  }

  .genre-card-body {
    padding:20px;
  }

  .genre-field {
    margin-bottom:14px;
  }

  .genre-label {
    display:block;
    margin-bottom:7px;
    color:#334155;
    font-size:12.5px;
    font-weight:900;
  }

  .genre-input,
  .genre-select {
    width:100%;
    height:42px;
    border:1px solid #CBD5E1;
    border-radius:13px;
    background:#fff;
    color:var(--text);
    padding:0 13px;
    outline:none;
    font-weight:650;
    transition:.18s ease;
  }

  .genre-input:focus,
  .genre-select:focus {
    border-color:var(--primary);
    box-shadow:0 0 0 4px rgba(79,70,229,.1);
  }

  .genre-switch-row {
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:12px 0 16px;
  }

  .genre-switch-label {
    font-weight:900;
    color:#334155;
    font-size:13px;
  }

  .genre-switch {
    position:relative;
    width:48px;
    height:26px;
  }

  .genre-switch input {
    opacity:0;
    width:0;
    height:0;
  }

  .genre-slider {
    position:absolute;
    inset:0;
    background:#CBD5E1;
    border-radius:999px;
    cursor:pointer;
    transition:.2s;
  }

  .genre-slider:before {
    content:'';
    position:absolute;
    width:20px;
    height:20px;
    left:3px;
    top:3px;
    background:#fff;
    border-radius:50%;
    transition:.2s;
    box-shadow:0 2px 8px rgba(15,23,42,.2);
  }

  .genre-switch input:checked + .genre-slider {
    background:var(--dark);
  }

  .genre-switch input:checked + .genre-slider:before {
    transform:translateX(22px);
  }

  .genre-form-actions {
    display:flex;
    gap:10px;
  }

  .genre-alert {
    background:#fff;
    border:1px solid var(--border);
    border-radius:16px;
    padding:14px 16px;
    color:#334155;
    font-size:13.5px;
    font-weight:850;
    margin-bottom:18px;
    display:flex;
    align-items:center;
    gap:10px;
  }

  .genre-tab-tools {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    margin-bottom:14px;
  }

  .genre-counter {
    display:inline-flex;
    align-items:center;
    height:30px;
    padding:0 11px;
    border-radius:999px;
    background:#F1F5F9;
    color:#475569;
    font-size:12px;
    font-weight:900;
  }

  .genre-chip-wrap {
    display:flex;
    flex-wrap:wrap;
    gap:10px;
  }

  .genre-chip {
    border:1px solid var(--border);
    background:#fff;
    color:var(--text);
    min-height:36px;
    border-radius:999px;
    padding:0 14px;
    font-size:12.5px;
    font-weight:950;
    cursor:pointer;
    transition:.16s ease;
  }

  .genre-chip:hover {
    transform:translateY(-2px);
    border-color:#94A3B8;
  }

  .genre-chip.selected {
    background:var(--dark);
    color:#fff;
    border-color:var(--dark);
    box-shadow:0 10px 22px rgba(15,23,42,.18);
  }

  .genre-chip.locked {
    background:#F8FAFC;
    color:var(--text);
    border-color:#CBD5E1;
    cursor:default;
  }

  .genre-chip.locked:hover {
    transform:none;
  }

  .genre-chip.disabled {
    opacity:.45;
    cursor:not-allowed;
  }

  .genre-toolbar {
    display:flex;
    gap:12px;
    align-items:center;
    justify-content:space-between;
    padding:16px 20px;
    border-bottom:1px solid var(--border);
    background:#fff;
  }

  .genre-search {
    position:relative;
    width:min(440px, 100%);
  }

  .genre-search span {
    position:absolute;
    left:13px;
    top:50%;
    transform:translateY(-50%);
    color:var(--soft);
    font-size:14px;
  }

  .genre-search input {
    width:100%;
    height:42px;
    border:1px solid var(--border);
    border-radius:13px;
    padding:0 14px 0 38px;
    outline:none;
    font-weight:700;
  }

  .genre-filter-row {
    display:flex;
    gap:8px;
    flex-wrap:wrap;
  }

  .genre-filter-btn {
    height:34px;
    border-radius:999px;
    padding:0 12px;
    border:1px solid var(--border);
    background:#fff;
    color:var(--muted);
    font-size:12px;
    font-weight:900;
    cursor:pointer;
    transition:.16s ease;
  }

  .genre-filter-btn:hover,
  .genre-filter-btn.active {
    background:var(--dark);
    color:#fff;
    border-color:var(--dark);
  }

  .genre-table-wrap {
    overflow:auto;
  }

  .genre-table {
    width:100%;
    border-collapse:collapse;
    font-size:13.5px;
  }

  .genre-table th {
    text-align:left;
    padding:13px 14px;
    background:#F8FAFC;
    color:#64748B;
    font-size:11.5px;
    text-transform:uppercase;
    letter-spacing:.06em;
    font-weight:950;
    white-space:nowrap;
  }

  .genre-table td {
    padding:15px 14px;
    border-top:1px solid #F1F5F9;
    vertical-align:middle;
  }

  .genre-table tbody tr {
    transition:.16s ease;
  }

  .genre-table tbody tr:hover {
    background:#FAFBFF;
  }

  .genre-table tbody tr.editing {
    background:#EEF2FF;
  }

  .genre-name-cell {
    font-weight:950;
    color:var(--text);
  }

  .genre-muted {
    color:var(--muted);
    font-weight:650;
  }

  .genre-badge {
    display:inline-flex;
    align-items:center;
    height:26px;
    padding:0 10px;
    border-radius:999px;
    font-size:11.5px;
    font-weight:950;
  }

  .genre-badge.active {
    background:var(--successBg);
    color:var(--success);
  }

  .genre-badge.disabled {
    background:#F1F5F9;
    color:#64748B;
  }

  .genre-badge.featured {
    background:#0F172A;
    color:#fff;
  }

  .genre-row-actions {
    display:flex;
    justify-content:flex-end;
    gap:8px;
  }

  .genre-small-btn {
    height:34px;
    border-radius:10px;
    padding:0 11px;
    font-size:12px;
    font-weight:950;
    cursor:pointer;
    transition:.16s ease;
  }

  .genre-small-btn.edit {
    background:#fff;
    border:1px solid #CBD5E1;
    color:var(--text);
  }

  .genre-small-btn.delete {
    background:#fff;
    border:1px solid #FECACA;
    color:var(--danger);
  }

  .genre-small-btn:hover {
    transform:translateY(-2px);
  }

  .genre-small-btn:disabled {
    opacity:.45;
    cursor:not-allowed;
    transform:none;
  }

  .genre-table-footer {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    padding:14px 20px;
    border-top:1px solid var(--border);
    background:#fff;
  }

  .genre-table-footer span {
    color:var(--muted);
    font-size:12.5px;
    font-weight:800;
  }

  .genre-record-list {
    display:grid;
    gap:10px;
  }

  .genre-record-item {
    display:flex;
    gap:12px;
    align-items:flex-start;
    padding:13px;
    border:1px solid #F1F5F9;
    border-radius:14px;
    background:#fff;
    transition:.16s ease;
  }

  .genre-record-item:hover {
    transform:translateY(-2px);
    border-color:#CBD5E1;
  }

  .genre-record-dot {
    width:32px;
    height:32px;
    border-radius:12px;
    background:#EEF2FF;
    color:var(--primary);
    display:flex;
    align-items:center;
    justify-content:center;
    font-weight:950;
    flex-shrink:0;
  }

  .genre-record-title {
    font-weight:950;
    color:var(--text);
    font-size:13px;
  }

  .genre-record-sub {
    margin-top:3px;
    color:var(--muted);
    font-weight:650;
    font-size:12px;
  }

  .genre-empty {
    padding:28px;
    text-align:center;
    color:var(--muted);
    font-weight:800;
  }

  @media (max-width:1100px) {
    .genre-stat-grid {
      grid-template-columns:repeat(2, minmax(0, 1fr));
    }

    .genre-control-grid {
      grid-template-columns:1fr;
    }
  }

  @media (max-width:760px) {
    .genre-header {
      padding:0 18px;
    }

    .genre-content {
      padding:22px 18px 40px;
    }

    .genre-page-top,
    .genre-toolbar,
    .genre-tab-tools {
      flex-direction:column;
      align-items:stretch;
    }

    .genre-stat-grid {
      grid-template-columns:1fr;
    }
  }
`

export default function GenreManagementPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [genres, setGenres] = useState([])
  const [featuredTabs, setFeaturedTabs] = useState([])
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [showAllGenres, setShowAllGenres] = useState(false)
  const [form, setForm] = useState({
    name: '',
    slug: '',
    sort_order: 0,
    is_active: true,
  })

  const navItems = {
    overview: [
      { path: '/admin', label: 'Dashboard', icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
      { path: '/shadow-exclusive', label: 'Shadow Exclusive', icon: 'M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z M9 12l2 2 4-5' },
      { path: '/authors', label: 'Authors Community', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
    ],
    visualMedia: [
      { path: '/slides', label: 'Slide Section', icon: 'M2 3h20v14H2z M8 21h8 M12 17v4' },
      { path: '/banners', label: 'Banner System', icon: 'M3 3h18v18H3z M3 9h18 M9 3v18' },
      { path: '/genres', label: 'Genre', icon: 'M4 6h16M4 12h16M4 18h16' },
      { path: '/advertisement', label: 'Advertisement', icon: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z' },
      { path: '/recommended', label: 'Recommended', icon: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' },
    ],
    systemAdmin: [
      { path: '/category', label: 'Category', icon: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' },
      { path: '/rule', label: 'Rule', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
      { path: '/account', label: 'Account', icon: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z' },
      { path: '/block-list', label: 'Block List', icon: 'M18.36 6.64L5.64 19.36m0-12.72l12.72 12.72M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z' },
    ],
    finance: [
      { path: '/income', label: 'Income', icon: 'M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
      { path: '/history', label: 'History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
      { path: '/deposit', label: 'Deposit', icon: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-5l5 5 5-5m-5 5V3' },
      { path: '/withdraw', label: 'Withdraw', icon: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-10l5-5 5 5m-5-5v12' },
      { path: '/ranking', label: 'Ranking', icon: 'M6 9H4.5a2.5 2.5 0 010-5H6 M18 9h1.5a2.5 2.5 0 000-5H18 M4 22h16 M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22 M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22 M18 2H6v7a6 6 0 0012 0V2z' },
    ],
  }

  const requestHeaders = {
    'Content-Type': 'application/json',
    ...(getAdminToken() ? { Authorization: `Bearer ${getAdminToken()}` } : {}),
    'X-Admin-Name': 'Admin',
  }

  const selectedGenreIds = useMemo(() => {
    return featuredTabs
      .filter((tab) => !tab.is_locked && tab.genre_id)
      .map((tab) => tab.genre_id)
  }, [featuredTabs])

  const featuredIdSet = useMemo(() => new Set(selectedGenreIds), [selectedGenreIds])

  const stats = useMemo(() => {
    const total = genres.length
    const active = genres.filter((genre) => genre.is_active).length
    const storyCount = genres.reduce((sum, genre) => sum + Number(genre.story_count || 0), 0)

    return [
      { label: 'Total Genres', value: total, note: 'All created genres' },
      { label: 'Active Genres', value: active, note: 'Available for stories' },
      { label: 'For You Tabs', value: `${selectedGenreIds.length + 1}/12`, note: 'Today plus selected genres' },
      { label: 'Stories Using Genres', value: storyCount, note: 'Based on current story data' },
    ]
  }, [genres, selectedGenreIds])

  const filteredGenres = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()

    return genres.filter((genre) => {
      const matchKeyword =
        !keyword ||
        String(genre.name || '').toLowerCase().includes(keyword) ||
        String(genre.slug || '').toLowerCase().includes(keyword)

      const matchFilter =
        filter === 'all' ||
        (filter === 'active' && genre.is_active) ||
        (filter === 'disabled' && !genre.is_active) ||
        (filter === 'featured' && featuredIdSet.has(genre.id))

      return matchKeyword && matchFilter
    })
  }, [genres, searchQuery, filter, featuredIdSet])

  const visibleGenres = showAllGenres ? filteredGenres : filteredGenres.slice(0, 5)

  function pushRecord(title, detail) {
    setRecords((current) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        title,
        detail,
        time: 'Just now',
      },
      ...current,
    ].slice(0, 8))
  }

  async function loadData() {
    try {
      setLoading(true)

      const [genresRes, tabsRes] = await Promise.all([
        fetch(`${API_URL}/api/genres/admin/records`, { headers: requestHeaders }),
        fetch(`${API_URL}/api/genres/featured-tabs?include_inactive=true`, { headers: requestHeaders }),
      ])

      const genresData = await genresRes.json().catch(() => ({}))
      const tabsData = await tabsRes.json().catch(() => ({}))

      if (!genresRes.ok || genresData.ok === false) {
        throw new Error(genresData.message || 'Failed to load genres')
      }

      if (!tabsRes.ok || tabsData.ok === false) {
        throw new Error(tabsData.message || 'Failed to load featured tabs')
      }

      setGenres(genresData.genres || [])
      setFeaturedTabs(tabsData.tabs || [])
    } catch (error) {
      setMessage(error.message || 'Failed to load genre data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  function resetForm() {
    setEditingId(null)
    setForm({
      name: '',
      slug: '',
      sort_order: 0,
      is_active: true,
    })
  }

  function handleNameChange(value) {
    setForm((current) => ({
      ...current,
      name: value,
      slug: editingId ? current.slug : slugify(value),
    }))
  }

  function handleEdit(genre) {
    setEditingId(genre.id)
    setForm({
      name: genre.name || '',
      slug: genre.slug || '',
      sort_order: genre.sort_order || 0,
      is_active: Boolean(genre.is_active),
    })
    setMessage(`Editing ${genre.name}`)
  }

  async function handleSubmit(event) {
    event.preventDefault()

    try {
      setSaving(true)
      setMessage('')

      const payload = {
        name: form.name,
        slug: form.slug || slugify(form.name),
        sort_order: Number(form.sort_order) || 0,
        is_active: Boolean(form.is_active),
      }

      const url = editingId
        ? `${API_URL}/api/genres/admin/records/${editingId}`
        : `${API_URL}/api/genres/admin/records`

      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || data.ok === false) {
        throw new Error(data.message || 'Failed to save genre')
      }

      const action = editingId ? 'Updated genre' : 'Created genre'
      setMessage(editingId ? 'Genre updated successfully' : 'Genre created successfully')
      pushRecord(action, payload.name)
      resetForm()
      await loadData()
    } catch (error) {
      setMessage(error.message || 'Failed to save genre')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(genre) {
    if (Number(genre.story_count || 0) > 0) {
      setMessage('This genre has stories. Disable it instead.')
      return
    }

    const confirmed = window.confirm(`Delete ${genre.name}?`)
    if (!confirmed) return

    try {
      setSaving(true)
      setMessage('')

      const res = await fetch(`${API_URL}/api/genres/admin/records/${genre.id}`, {
        method: 'DELETE',
        headers: requestHeaders,
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || data.ok === false) {
        throw new Error(data.message || 'Failed to delete genre')
      }

      setMessage('Genre deleted successfully')
      pushRecord('Deleted genre', genre.name)
      await loadData()
    } catch (error) {
      setMessage(error.message || 'Failed to delete genre')
    } finally {
      setSaving(false)
    }
  }

  function toggleFeaturedGenre(genreId) {
    const exists = selectedGenreIds.includes(genreId)

    if (exists) {
      setFeaturedTabs((current) => current.filter((tab) => tab.genre_id !== genreId))
      return
    }

    if (selectedGenreIds.length >= 11) {
      setMessage('For You can show only 11 custom genres plus Today')
      return
    }

    const genre = genres.find((item) => item.id === genreId)
    if (!genre || !genre.is_active) return

    setFeaturedTabs((current) => [
      ...current,
      {
        genre_id: genre.id,
        label: genre.name,
        slug: genre.slug,
        is_locked: false,
        is_active: true,
        sort_order: (current.length + 1) * 10,
        genre,
      },
    ])
  }

  async function saveFeaturedTabs() {
    try {
      setSaving(true)
      setMessage('')

      const res = await fetch(`${API_URL}/api/genres/admin/featured-tabs`, {
        method: 'PUT',
        headers: requestHeaders,
        body: JSON.stringify({ genre_ids: selectedGenreIds }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || data.ok === false) {
        throw new Error(data.message || 'Failed to save featured tabs')
      }

      setMessage('For You genre tabs updated successfully')
      pushRecord('Updated For You tabs', `${selectedGenreIds.length + 1} tabs active`)
      await loadData()
    } catch (error) {
      setMessage(error.message || 'Failed to save featured tabs')
    } finally {
      setSaving(false)
    }
  }

  function renderNavGroup(label, items) {
    return (
      <>
        <span className="genre-nav-label">{label}</span>
        {items.map((item) => (
          <div
            key={item.path}
            className={`genre-nav-item ${location.pathname === item.path ? 'active' : ''}`}
            onClick={() => navigate(item.path)}
          >
            <Icon d={item.icon} size={20} />
            <span className="genre-nav-text">{item.label}</span>
          </div>
        ))}
      </>
    )
  }

  return (
    <>
      <style>{styles}</style>
      <div className="genre-admin-shell">
        <aside className="genre-sidebar">
          <div className="genre-logo">
            <Icon d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            <span className="genre-logo-text">Shadow Exclusive</span>
          </div>

          {renderNavGroup('Overview', navItems.overview)}
          {renderNavGroup('Visual Media', navItems.visualMedia)}
          {renderNavGroup('System Admin', navItems.systemAdmin)}
          {renderNavGroup('Finance & Growth', navItems.finance)}
        </aside>

        <main className="genre-main">
          <header className="genre-header">
            <h2>Genre Management</h2>
            <button className="genre-dark-btn" type="button" onClick={saveFeaturedTabs} disabled={saving}>
              {saving ? 'Saving...' : 'Save Tabs'}
            </button>
          </header>

          <div className="genre-content">
            <div className="genre-page-top">
              <div>
                <h1>Genre Management</h1>
                <p>Manage story genres, active status, and the Novel tab genres shown on For You.</p>
              </div>
              <button className="genre-ghost-btn" type="button" onClick={loadData} disabled={loading || saving}>
                Refresh
              </button>
            </div>

            {message && (
              <div className="genre-alert">
                <span>●</span>
                <span>{message}</span>
              </div>
            )}

            <div className="genre-stat-grid">
              {stats.map((item) => (
                <div className="genre-stat-card" key={item.label}>
                  <div className="genre-stat-label">{item.label}</div>
                  <div className="genre-stat-value">{item.value}</div>
                  <div className="genre-stat-note">{item.note}</div>
                </div>
              ))}
            </div>

            <div className="genre-stack">
              <div className="genre-control-grid">
                <div className="genre-card">
                  <div className="genre-card-head">
                    <div>
                      <h3>{editingId ? 'Edit Genre' : 'Create Genre'}</h3>
                      <p>{editingId ? 'Update selected genre information.' : 'Add a new story genre.'}</p>
                    </div>
                  </div>

                  <div className="genre-card-body">
                    <form onSubmit={handleSubmit}>
                      <div className="genre-field">
                        <label className="genre-label">Name</label>
                        <input
                          className="genre-input"
                          value={form.name}
                          onChange={(event) => handleNameChange(event.target.value)}
                          placeholder="Romance"
                          required
                        />
                      </div>

                      <div className="genre-field">
                        <label className="genre-label">Slug</label>
                        <input
                          className="genre-input"
                          value={form.slug}
                          onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))}
                          placeholder="romance"
                          required
                        />
                      </div>

                      <div className="genre-field">
                        <label className="genre-label">Sort Order</label>
                        <input
                          className="genre-input"
                          type="number"
                          value={form.sort_order}
                          onChange={(event) => setForm((current) => ({ ...current, sort_order: event.target.value }))}
                        />
                      </div>

                      <div className="genre-switch-row">
                        <span className="genre-switch-label">Active Genre</span>
                        <label className="genre-switch">
                          <input
                            type="checkbox"
                            checked={form.is_active}
                            onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))}
                          />
                          <span className="genre-slider" />
                        </label>
                      </div>

                      <div className="genre-form-actions">
                        <button className="genre-dark-btn" type="submit" disabled={saving}>
                          {saving ? 'Saving...' : editingId ? 'Update Genre' : 'Create Genre'}
                        </button>
                        {editingId && (
                          <button className="genre-ghost-btn" type="button" onClick={resetForm}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </form>
                  </div>
                </div>

                <div className="genre-card">
                  <div className="genre-card-head">
                    <div>
                      <h3>For You Genre Tabs</h3>
                      <p>Today is locked. Choose up to 11 more genres for the Novel tab.</p>
                    </div>
                    <span className="genre-counter">{selectedGenreIds.length + 1}/12 Tabs</span>
                  </div>

                  <div className="genre-card-body">
                    <div className="genre-tab-tools">
                      <div className="genre-counter">Selected genres appear as black buttons</div>
                      <div className="genre-counter">Today + {selectedGenreIds.length} genres selected</div>
                    </div>

                    <div className="genre-chip-wrap">
                      <button className="genre-chip locked" type="button">
                        Today 🔒
                      </button>

                      {genres.map((genre) => {
                        const selected = selectedGenreIds.includes(genre.id)
                        return (
                          <button
                            key={genre.id}
                            type="button"
                            className={`genre-chip ${selected ? 'selected' : ''} ${!genre.is_active ? 'disabled' : ''}`}
                            onClick={() => toggleFeaturedGenre(genre.id)}
                            disabled={!genre.is_active}
                          >
                            {selected ? '✓ ' : ''}{genre.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="genre-card">
                <div className="genre-card-head">
                  <div>
                    <h3>All Genres</h3>
                    <p>Search, filter, edit, disable, or delete unused genres.</p>
                  </div>
                </div>

                <div className="genre-toolbar">
                  <div className="genre-search">
                    <span>⌕</span>
                    <input
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value)
                        setShowAllGenres(false)
                      }}
                      placeholder="Search genre by name or slug..."
                    />
                  </div>

                  <div className="genre-filter-row">
                    {['all', 'active', 'disabled', 'featured'].map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={`genre-filter-btn ${filter === item ? 'active' : ''}`}
                        onClick={() => {
                          setFilter(item)
                          setShowAllGenres(false)
                        }}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>

                {loading ? (
                  <div className="genre-empty">Loading genres...</div>
                ) : filteredGenres.length === 0 ? (
                  <div className="genre-empty">No genre found</div>
                ) : (
                  <>
                    <div className="genre-table-wrap">
                      <table className="genre-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Slug</th>
                            <th>Stories</th>
                            <th>For You</th>
                            <th>Status</th>
                            <th>Sort</th>
                            <th style={{ textAlign: 'right' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleGenres.map((genre) => {
                            const isFeatured = featuredIdSet.has(genre.id)
                            const hasStories = Number(genre.story_count || 0) > 0

                            return (
                              <tr key={genre.id} className={editingId === genre.id ? 'editing' : ''}>
                                <td className="genre-name-cell">{genre.name}</td>
                                <td className="genre-muted">{genre.slug}</td>
                                <td className="genre-muted">{genre.story_count || 0}</td>
                                <td>
                                  {isFeatured ? (
                                    <span className="genre-badge featured">Featured</span>
                                  ) : (
                                    <span className="genre-muted">No</span>
                                  )}
                                </td>
                                <td>
                                  <span className={`genre-badge ${genre.is_active ? 'active' : 'disabled'}`}>
                                    {genre.is_active ? 'Active' : 'Disabled'}
                                  </span>
                                </td>
                                <td className="genre-muted">{genre.sort_order || 0}</td>
                                <td>
                                  <div className="genre-row-actions">
                                    <button className="genre-small-btn edit" type="button" onClick={() => handleEdit(genre)}>
                                      Edit
                                    </button>
                                    <button
                                      className="genre-small-btn delete"
                                      type="button"
                                      onClick={() => handleDelete(genre)}
                                      disabled={saving || hasStories}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="genre-table-footer">
                      <span>Showing {visibleGenres.length} of {filteredGenres.length} genres</span>
                      {filteredGenres.length > 5 && (
                        <button className="genre-ghost-btn" type="button" onClick={() => setShowAllGenres((current) => !current)}>
                          {showAllGenres ? 'Show Less' : 'View All Genres'}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="genre-card">
                <div className="genre-card-head">
                  <div>
                    <h3>Recent Genre Records</h3>
                    <p>Latest genre changes from this admin session.</p>
                  </div>
                </div>

                <div className="genre-card-body">
                  {records.length === 0 ? (
                    <div className="genre-empty">No recent genre records yet</div>
                  ) : (
                    <div className="genre-record-list">
                      {records.map((record) => (
                        <div className="genre-record-item" key={record.id}>
                          <div className="genre-record-dot">✓</div>
                          <div>
                            <div className="genre-record-title">{record.title}</div>
                            <div className="genre-record-sub">{record.detail} · {record.time}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>          </div>
        </main>
      </div>
    </>
  )
}
