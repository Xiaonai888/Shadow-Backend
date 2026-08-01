import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminSecurityBell from '../components/AdminSecurityBell';
import AdminSidebar from '../components/AdminSidebar';
const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com';


const styles = `
  :root {
    --bg-main: #F8FAFC;
    --bg-card: #FFFFFF;
    --primary: #4F46E5;
    --primary-light: #EEF2FF;
    --text-main: #0F172A;
    --text-muted: #64748B;
    --success: #10B981;
    --success-light: #D1FAE5;
    --warning: #F59E0B;
    --danger: #EF4444;
    --danger-light: #FEE2E2;
    --border: #E2E8F0;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes barGrow {
    from { transform: scaleY(0); }
    to { transform: scaleY(1); }
  }

  .dashboard-wrapper {
    display: flex;
    height: 100vh;
    background-color: var(--bg-main);
    color: var(--text-main);
    overflow: hidden;
  }

  /* ===== MAIN CONTENT ===== */
  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  /* ===== HEADER ===== */
  .header {
    height: 70px;
    background: #FFFFFF;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 36px;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-left h2 {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-main);
  }

  /* Search Bar */
  .search-wrap {
    position: relative;
  }

  .search-input {
    background: #F1F5F9;
    border: 1.5px solid transparent;
    border-radius: 12px;
    padding: 9px 14px 9px 40px;
    width: 300px;
    outline: none;
    font-size: 13.5px;
    font-family: 'Inter', sans-serif;
    color: var(--text-main);
    transition: all 0.2s;
  }

  .search-input:focus {
    background: #fff;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
    width: 340px;
  }

  .search-input::placeholder { color: #94A3B8; }

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #94A3B8;
    pointer-events: none;
  }

  /* Search dropdown */
  .search-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    width: 340px;
    background: #fff;
    border-radius: 14px;
    border: 1px solid var(--border);
    box-shadow: 0 12px 40px rgba(0,0,0,0.1);
    overflow: hidden;
    z-index: 999;
    animation: fadeIn 0.15s ease;
  }

  .search-section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-muted);
    padding: 10px 14px 6px;
  }

  .search-result-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .search-result-item:hover { background: #F8FAFC; }

  .search-result-icon {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    flex-shrink: 0;
  }

  .search-result-item .info { flex: 1; min-width: 0; }
  .search-result-item .name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-result-item .sub { font-size: 11px; color: var(--text-muted); margin-top: 1px; }

  .search-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 20px;
  }

  /* Profile */
  .profile-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    padding: 5px 8px;
    border-radius: 12px;
    transition: background 0.15s;
  }

  .profile-btn:hover { background: #F1F5F9; }

  .profile-avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: linear-gradient(135deg, #4F46E5, #7C3AED);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    border: 2px solid #E2E8F0;
    flex-shrink: 0;
  }

  .profile-menu {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    background: white;
    border-radius: 16px;
    width: 220px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.12);
    border: 1px solid #E2E8F0;
    overflow: hidden;
    animation: fadeIn 0.15s ease;
    z-index: 200;
  }

  .profile-menu-header {
    padding: 16px;
    background: linear-gradient(135deg, #F0F0FF, #EEF2FF);
    border-bottom: 1px solid #E0E7FF;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .profile-menu-avatar {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: linear-gradient(135deg, #4F46E5, #7C3AED);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 15px;
    flex-shrink: 0;
  }

  .profile-menu-name { font-weight: 700; font-size: 14px; }
  .profile-menu-role { font-size: 11px; color: var(--primary); font-weight: 600; }

  .profile-menu-body { padding: 8px; }

  .profile-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 13.5px;
    color: #475569;
    font-weight: 500;
    transition: background 0.15s;
  }

  .profile-menu-item:hover { background: #F1F5F9; }
  .profile-menu-item.danger { color: #EF4444; }
  .profile-menu-item.danger:hover { background: #FEF2F2; }

  .profile-menu-divider { height: 1px; background: #F1F5F9; margin: 4px 0; }

  /* ===== CONTENT BODY ===== */
  .content-body {
    padding: 28px 36px;
    max-width: 1600px;
    width: 100%;
    margin: 0 auto;
    animation: fadeIn 0.4s ease-out;
  }

  .welcome-row {
    margin-bottom: 24px;
  }

  .welcome-row h1 {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-main);
  }

  .welcome-row p {
    font-size: 13.5px;
    color: var(--text-muted);
    margin-top: 3px;
  }

  /* ===== STAT CARDS ===== */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    margin-bottom: 28px;
  }

  .stat-card {
    background: var(--bg-card);
    border-radius: 16px;
    padding: 22px 24px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    border: 1px solid var(--border);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .stat-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 8px 20px rgba(0,0,0,0.08);
  }

  .stat-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .stat-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-icon-box {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .stat-value {
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
    margin-bottom: 8px;
  }

  .stat-trend {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
  }

  /* ===== BENTO GRID ===== */
  .bento-grid {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 20px;
    margin-bottom: 24px;
  }

  .card-panel {
    background: var(--bg-card);
    border-radius: 16px;
    padding: 22px 24px;
    border: 1px solid var(--border);
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .panel-header h4 { font-weight: 700; font-size: 15px; }

  .panel-link {
    font-size: 12px;
    color: var(--primary);
    font-weight: 600;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 8px;
    transition: background 0.15s;
  }

  .panel-link:hover { background: var(--primary-light); }

  /* Chart */
  .chart-wrap {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    height: 160px;
    padding-top: 10px;
  }

  .chart-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
    gap: 6px;
  }

  .chart-bar-wrap {
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    flex: 1;
  }

  .chart-bar {
    width: 80%;
    border-radius: 6px 6px 0 0;
    transition: all 0.3s ease;
    transform-origin: bottom;
    animation: barGrow 0.6s ease-out forwards;
  }

  .chart-value {
    font-size: 10px;
    color: var(--text-main);
    font-weight: 700;
    line-height: 1;
  }

  .chart-day {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 500;
  }

  .dashboard-search-state {
    padding: 18px 14px;
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
  }

  /* Log Items */
  .log-list { display: flex; flex-direction: column; gap: 14px; }

  .log-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .log-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .log-text { font-size: 13px; line-height: 1.5; }
  .log-time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

  .view-all-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    margin-top: 16px;
    padding: 10px;
    border-radius: 10px;
    background: #F8FAFC;
    border: 1px solid var(--border);
    color: var(--primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .view-all-btn:hover { background: var(--primary-light); }

  /* ===== SHADOW EXCLUSIVE TABLE ===== */
  .exclusive-table-wrap { overflow-x: auto; }

  .exclusive-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }

  .exclusive-table thead tr {
    border-bottom: 1.5px solid var(--border);
  }

  .exclusive-table th {
    padding: 10px 12px;
    text-align: left;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .exclusive-table td {
    padding: 14px 12px;
    border-bottom: 1px solid #F8FAFC;
    vertical-align: middle;
  }

  .exclusive-table tr:last-child td { border-bottom: none; }

  .exclusive-table tr:hover td { background: #FAFBFF; }

  .exclusive-title-cell {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .live-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
    margin-right: 6px;
    box-shadow: 0 0 0 2px rgba(16,185,129,0.2);
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(16,185,129,0.2); }
    50% { box-shadow: 0 0 0 5px rgba(16,185,129,0.1); }
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 11px;
    border-radius: 20px;
    font-size: 11.5px;
    font-weight: 700;
  }

  .badge-published {
    background: var(--success-light);
    color: var(--success);
  }

  .badge-pending {
    background: #FEF3C7;
    color: #D97706;
  }

  .badge-approved {
    background: var(--success-light);
    color: var(--success);
  }

  .badge-rejected {
    background: var(--danger-light);
    color: var(--danger);
  }

  .badge-removed {
    background: #F1F5F9;
    color: #475569;
  }

  @media (max-width: 768px) {
    .header {
      height: auto;
      min-height: 70px;
      flex-wrap: wrap;
      gap: 10px;
      padding-top: 12px !important;
      padding-right: 12px !important;
      padding-bottom: 12px !important;
    }

    .header-left {
      min-width: 0;
    }

    .header-left h2 {
      font-size: 15px;
      white-space: nowrap;
    }

    .header-actions {
      width: 100%;
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 8px !important;
    }

    .search-wrap {
      min-width: 0;
    }

    .search-input,
    .search-input:focus {
      width: 100%;
      min-width: 0;
    }

    .search-dropdown {
      width: min(340px, calc(100vw - 94px));
    }

    .profile-btn {
      gap: 0;
      padding: 4px;
    }

    .profile-btn > svg {
      display: none;
    }

    .profile-menu {
      width: min(220px, calc(100vw - 32px));
    }

    .bento-grid {
      grid-template-columns: 1fr;
    }

    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .content-body {
      padding: 20px 16px 36px;
    }

    .stat-card,
    .card-panel {
      padding: 18px;
    }

    .panel-header {
      gap: 10px;
    }

    .chart-wrap {
      gap: 5px;
    }

    .exclusive-table {
      min-width: 680px;
    }
  }

  @media (max-width: 520px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }

    .welcome-row h1 {
      font-size: 20px;
    }

    .panel-header {
      align-items: flex-start;
    }
  }
`;

const Icon = ({ d, size = 20, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color || "currentColor"} strokeWidth={2.2}
    strokeLinecap="round" strokeLinejoin="round"
    style={{ minWidth: `${size}px`, flexShrink: 0 }}>
    <path d={d} />
  </svg>
);

function getAdminToken() {
  return sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || '';
}
function getLogInitial(record) {
  const actor = record?.actor || 'Admin';
  return actor.charAt(0).toUpperCase();
}

function getLogColor(action) {
  const value = String(action || '').toUpperCase();

  if (value === 'DELETE') return '#EF4444';
  if (value === 'CREATE') return '#10B981';
  if (value === 'VISIBILITY') return '#F59E0B';
  if (value === 'UPDATE') return '#4F46E5';

  return '#6366F1';
}

function formatLogTime(value) {
  if (!value) return '';

  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min${diffMinutes > 1 ? 's' : ''} ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

  return date.toLocaleString();
}

function getLogText(record) {
  const action = String(record?.action || 'UPDATE').toUpperCase();
  const title = record?.slide_title || (record?.order_index ? `Slide ${record.order_index}` : 'item');
  const detail = record?.details || '';

  if (detail) return detail;
  if (action === 'DELETE') return `Deleted ${title}`;
  if (action === 'CREATE') return `Created ${title}`;
  if (action === 'VISIBILITY') return `Changed visibility for ${title}`;

  return `Updated ${title}`;
}


function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function getLocalDayRange(offsetDays = 0) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    from: start.toISOString(),
    to: end.toISOString(),
  };
}

function formatExclusiveStatus(value) {
  const status = String(value || 'pending').toLowerCase();
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'removed' || status === 'none') return 'Removed';
  return 'Pending';
}

function formatExclusiveSections(value) {
  const sections = Array.isArray(value) ? value : [];
  if (!sections.length) return 'Not assigned';

  return sections
    .map((item) => String(item || '').replace(/_/g, ' '))
    .map((item) => item.replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .join(' / ');
}

async function fetchAdminJson(path) {
  const token = getAdminToken();
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || 'Failed to load dashboard data');
  }

  return data;
}

const AdminDashboard = () => {
  const navigate = useNavigate();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState({ exclusive: [], authors: [] });
  const [activityLog, setActivityLog] = useState([]);
  const [activityLogLoading, setActivityLogLoading] = useState(true);
  const [exclusiveLoading, setExclusiveLoading] = useState(true);
  const [exclusiveSummary, setExclusiveSummary] = useState({ exclusive_stories: 0, pending_requests: 0 });
  const [exclusiveStories, setExclusiveStories] = useState([]);
  const [visitorSummary, setVisitorSummary] = useState({
    total_unique_visitors: 0,
    total_sessions: 0,
    visitors_today: 0,
    visitors_this_month: 0,
    active_last_10_minutes: 0,
    total_page_views: 0,
    readers_today: 0,
    active_readers_last_10_minutes: 0,
    stories_updated_today: 0,
    episodes_published_today: 0,
  });
  const [incomeSummary, setIncomeSummary] = useState({ today: 0, yesterday: 0 });
  const [adminProfile, setAdminProfile] = useState(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem('shadow_admin_user')
        || localStorage.getItem('shadow_admin_user')
        || '{}'
      );
    } catch {
      return {};
    }
  });

  const currentUserName = adminProfile.name || adminProfile.email || 'Loading...';
  const currentUserRole = adminProfile.role || 'Loading...';

  const handleSignOut = () => {
    sessionStorage.removeItem('shadow_admin_token');
    localStorage.removeItem('shadow_admin_token');
    sessionStorage.removeItem('shadow_admin_user');
    localStorage.removeItem('shadow_admin_user');
    navigate('/login', { replace: true });
  };

  const fetchActivityLogs = async () => {
    try {
      setActivityLogLoading(true);
      const token = getAdminToken();
      const response = await fetch(`${API_URL}/api/slides/records?page=1&limit=3`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Admin-Name': 'Admin',
        },
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok === false) {
        throw new Error(data.message || 'Failed to load admin activity logs');
      }

      setActivityLog(data.records || []);
    } catch {
      setActivityLog([]);
    } finally {
      setActivityLogLoading(false);
    }
  };

  const fetchExclusiveDashboard = async () => {
    try {
      setExclusiveLoading(true);
      const [pendingData, approvedData] = await Promise.all([
        fetchAdminJson('/api/admin/exclusive/stories?status=pending&limit=3'),
        fetchAdminJson('/api/admin/exclusive/stories?status=approved&limit=3'),
      ]);

      const summary = pendingData.summary || approvedData.summary || {};
      const storyMap = new Map();

      [...(pendingData.stories || []), ...(approvedData.stories || [])].forEach((story) => {
        storyMap.set(story.id, story);
      });

      const stories = [...storyMap.values()]
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
        .slice(0, 3);

      setExclusiveSummary({
        exclusive_stories: Number(summary.exclusive_stories || 0),
        pending_requests: Number(summary.pending_requests || 0),
      });
      setExclusiveStories(stories);
    } catch {
      setExclusiveSummary({ exclusive_stories: 0, pending_requests: 0 });
      setExclusiveStories([]);
    } finally {
      setExclusiveLoading(false);
    }
  };

  const fetchVisitorDashboard = async () => {
    try {
      const data = await fetchAdminJson('/api/admin/community/visitors/overview');
      setVisitorSummary((current) => ({ ...current, ...(data.summary || {}) }));
    } catch {
      setVisitorSummary({
        total_unique_visitors: 0,
        total_sessions: 0,
        visitors_today: 0,
        visitors_this_month: 0,
        active_last_10_minutes: 0,
        total_page_views: 0,
        readers_today: 0,
        active_readers_last_10_minutes: 0,
        stories_updated_today: 0,
        episodes_published_today: 0,
      });
    }
  };

  const fetchIncomeDashboard = async () => {
    try {
      const today = getLocalDayRange(0);
      const yesterday = getLocalDayRange(-1);
      const [todayData, yesterdayData] = await Promise.all([
        fetchAdminJson(`/api/admin/income/summary?from=${encodeURIComponent(today.from)}&to=${encodeURIComponent(today.to)}`),
        fetchAdminJson(`/api/admin/income/summary?from=${encodeURIComponent(yesterday.from)}&to=${encodeURIComponent(yesterday.to)}`),
      ]);

      setIncomeSummary({
        today: Number(todayData.summary?.net_platform_income_usd || 0),
        yesterday: Number(yesterdayData.summary?.net_platform_income_usd || 0),
      });
    } catch {
      setIncomeSummary({ today: 0, yesterday: 0 });
    }
  };

  useEffect(() => {
    let ignore = false;

    async function loadAdminProfile() {
      const token = getAdminToken();
      if (!token) return;

      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));

        if (!ignore && response.ok && data.ok && data.admin) {
          setAdminProfile(data.admin);
          sessionStorage.setItem('shadow_admin_user', JSON.stringify(data.admin));

          if (localStorage.getItem('shadow_admin_token')) {
            localStorage.setItem('shadow_admin_user', JSON.stringify(data.admin));
          }
        }
      } catch {
      }
    }

    fetchActivityLogs();
    fetchExclusiveDashboard();
    fetchVisitorDashboard();
    fetchIncomeDashboard();
    loadAdminProfile();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();

    if (!query) {
      setSearchLoading(false);
      setSearchResults({ exclusive: [], authors: [] });
      return undefined;
    }

    let ignore = false;
    const timer = window.setTimeout(async () => {
      try {
        setSearchLoading(true);
        const encoded = encodeURIComponent(query);
        const [pendingData, approvedData, authorsData] = await Promise.all([
          fetchAdminJson(`/api/admin/exclusive/stories?status=pending&search=${encoded}&limit=5`),
          fetchAdminJson(`/api/admin/exclusive/stories?status=approved&search=${encoded}&limit=5`),
          fetchAdminJson(`/api/admin/community/authors?q=${encoded}&limit=5`),
        ]);

        if (ignore) return;

        const storyMap = new Map();
        [...(pendingData.stories || []), ...(approvedData.stories || [])].forEach((story) => {
          storyMap.set(story.id, story);
        });

        setSearchResults({
          exclusive: [...storyMap.values()].slice(0, 5).map((story) => {
            const status = formatExclusiveStatus(story.exclusive_status);
            const approved = status === 'Approved';
            return {
              id: story.id,
              name: story.title || 'Untitled story',
              sub: `${story.main_genre || 'Story'} · EP ${Number(story.total_episodes || 0)}`,
              color: approved ? '#EEF2FF' : '#FFF7ED',
              icon: approved ? '◆' : '◈',
              badge: status,
              badgeColor: approved ? '#D1FAE5' : '#FEF3C7',
              badgeText: approved ? '#047857' : '#B45309',
            };
          }),
          authors: (authorsData.authors || []).slice(0, 5).map((author) => ({
            id: author.id,
            name: author.author_name || author.username || 'Author',
            sub: `@${author.username || 'no_username'} · ${Number(author.books_count || 0)} stories`,
            color: '#F0FDF4',
            icon: '✍',
          })),
        });
      } catch {
        if (!ignore) setSearchResults({ exclusive: [], authors: [] });
      } finally {
        if (!ignore) setSearchLoading(false);
      }
    }, 300);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const incomeDifference = incomeSummary.today - incomeSummary.yesterday;
  const incomeTrendUp = incomeDifference >= 0;
  const incomeTrend = incomeSummary.yesterday > 0
    ? `${incomeDifference >= 0 ? '+' : ''}${((incomeDifference / incomeSummary.yesterday) * 100).toFixed(1)}% vs yesterday`
    : incomeSummary.today > 0
      ? 'Income received today'
      : 'No income today';

  const chartData = [
    { day: 'Today', value: Number(visitorSummary.visitors_today || 0), active: true },
    { day: 'Month', value: Number(visitorSummary.visitors_this_month || 0) },
    { day: 'Active', value: Number(visitorSummary.active_last_10_minutes || 0) },
    { day: 'Unique', value: Number(visitorSummary.total_unique_visitors || 0) },
    { day: 'Sessions', value: Number(visitorSummary.total_sessions || 0) },
    { day: 'Views', value: Number(visitorSummary.total_page_views || 0) },
  ];
  const maxVal = Math.max(1, ...chartData.map((item) => item.value));
  const hasResults = searchResults.exclusive.length + searchResults.authors.length > 0;

  const stats = [
    {
      label: 'Stories Updated Today',
      value: Number(visitorSummary.stories_updated_today || 0).toLocaleString(),
      trend: `${Number(visitorSummary.episodes_published_today || 0).toLocaleString()} new episodes today`,
      trendUp: true,
      icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z M12 7v6 M9 10h6',
      iconBg: '#EEF2FF', iconColor: '#4F46E5', valueColor: '#0F172A',
    },
    {
      label: 'Readers Today',
      value: Number(visitorSummary.readers_today || 0).toLocaleString(),
      trend: `${Number(visitorSummary.active_readers_last_10_minutes || 0).toLocaleString()} active in 10 min`,
      trendUp: true,
      icon: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
      iconBg: '#FFF7ED', iconColor: '#F59E0B', valueColor: '#0F172A',
    },
    {
      label: 'Visitors Today',
      value: Number(visitorSummary.visitors_today || 0).toLocaleString(),
      trend: `${Number(visitorSummary.active_last_10_minutes || 0).toLocaleString()} active in 10 min`,
      trendUp: true,
      icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
      iconBg: '#F0FDF4', iconColor: '#10B981', valueColor: '#0F172A',
    },
    {
      label: 'Daily Income',
      value: formatMoney(incomeSummary.today),
      trend: incomeTrend,
      trendUp: incomeTrendUp,
      icon: 'M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 0 010 7H6',
      iconBg: '#F0FDF4', iconColor: '#10B981', valueColor: '#10B981',
    },
    {
      hidden: true,
      label: 'Exclusive Stories',
      value: exclusiveSummary.exclusive_stories.toLocaleString(),
      trend: `${exclusiveSummary.pending_requests} pending review`,
      trendUp: true,
      icon: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
      iconBg: '#EEF2FF', iconColor: '#4F46E5', valueColor: '#0F172A',
    },
    {
      hidden: true,
      label: 'Consent Requests',
      value: exclusiveSummary.pending_requests.toLocaleString(),
      trend: exclusiveSummary.pending_requests === 1 ? 'Request needs attention' : 'Requests need attention',
      trendUp: false,
      icon: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
      iconBg: '#FEF2F2', iconColor: '#EF4444', valueColor: '#EF4444',
    },
  ];

  const visibleStats = stats.filter((stat) => !stat.hidden);

  const getHour = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <>
      <style>{styles}</style>
      <div className="dashboard-wrapper">
        <AdminSidebar />
        <div className="main-content">
          <header className="header">
            <div className="header-left">
              <h2>Dashboard Overview</h2>
            </div>

            <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
              <div className="search-wrap">
                <svg className="search-icon" width={16} height={16} fill="none" stroke="#94A3B8" strokeWidth={2.5}>
                  <circle cx={7} cy={7} r={5} />
                  <line x1={11} y1={11} x2={15} y2={15} />
                </svg>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search exclusive stories and authors..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setShowSearchDropdown(true);
                  }}
                  onFocus={() => setShowSearchDropdown(true)}
                  onBlur={() => window.setTimeout(() => setShowSearchDropdown(false), 200)}
                />

                {showSearchDropdown && searchQuery.trim() && (
                  <div className="search-dropdown">
                    {searchLoading ? (
                      <div className="dashboard-search-state">Searching real data...</div>
                    ) : hasResults ? (
                      <>
                        {searchResults.exclusive.length > 0 && (
                          <>
                            <div className="search-section-title">Shadow Exclusive</div>
                            {searchResults.exclusive.map((item) => (
                              <div
                                className="search-result-item"
                                key={`story-${item.id}`}
                                onMouseDown={() => navigate('/shadow-exclusive')}
                              >
                                <div className="search-result-icon" style={{ background: item.color }}>{item.icon}</div>
                                <div className="info">
                                  <div className="name">{item.name}</div>
                                  <div className="sub">{item.sub}</div>
                                </div>
                                <span className="search-badge" style={{ background: item.badgeColor, color: item.badgeText }}>
                                  {item.badge}
                                </span>
                              </div>
                            ))}
                          </>
                        )}

                        {searchResults.authors.length > 0 && (
                          <>
                            <div className="search-section-title">Authors</div>
                            {searchResults.authors.map((item) => (
                              <div
                                className="search-result-item"
                                key={`author-${item.id}`}
                                onMouseDown={() => navigate('/authors')}
                              >
                                <div className="search-result-icon" style={{ background: item.color }}>{item.icon}</div>
                                <div className="info">
                                  <div className="name">{item.name}</div>
                                  <div className="sub">{item.sub}</div>
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                      </>
                    ) : (
                      <div className="dashboard-search-state">No matching real data found.</div>
                    )}
                  </div>
                )}
              </div>

              <div
                style={{ position: 'relative', cursor: 'pointer', padding: '6px', borderRadius: '10px' }}
                onClick={() => navigate('/reader-mails')}
                title="Reader Mail"
              >
                <Icon d="M4 4h16v16H4z M4 7l8 6 8-6" size={20} color="#64748B" />
              </div>

              <AdminSecurityBell />

              <div style={{ position: 'relative' }}>
                <div className="profile-btn" onClick={() => setShowProfileMenu(!showProfileMenu)}>
                  <div className="profile-avatar">{currentUserName.charAt(0)}</div>
                  <Icon d="M6 9l6 6 6-6" size={16} color="#64748B" />
                </div>

                {showProfileMenu && (
                  <div className="profile-menu">
                    <div className="profile-menu-header">
                      <div className="profile-menu-avatar">{currentUserName.charAt(0)}</div>
                      <div>
                        <div className="profile-menu-name">{currentUserName}</div>
                        <div className="profile-menu-role">{currentUserRole}</div>
                      </div>
                    </div>
                    <div className="profile-menu-body">
                      <div className="profile-menu-item">
                        <Icon d="M12 20h9 M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" size={15} />
                        Edit Profile
                      </div>
                      <div className="profile-menu-item" onClick={() => navigate('/admin/settings')}>
                        <Icon d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .33 1.65 1.65 0 0 0-.82 1.43V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-.82-1.43 1.65 1.65 0 0 0-1-.33 1.65 1.65 0 0 0-1.82-.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.33-1 1.65 1.65 0 0 0-1.43-.82H2.75a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.43-.82A1.65 1.65 0 0 0 4.6 7a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.33A1.65 1.65 0 0 0 10.82 2.84V2.75a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 .82 1.43 1.65 1.65 0 0 0 1 .33 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c0 .35.11.69.33 1 .21.31.52.53.88.62h.09a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.43.82c-.22.31-.33.65-.33 1z" size={15} />
                        Settings
                      </div>
                      <div className="profile-menu-divider" />
                      <div className="profile-menu-item danger" onClick={handleSignOut}>
                        <Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9" size={15} color="#EF4444" />
                        Sign Out
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="content-body">
            <div className="welcome-row">
              <h1>{getHour()}, {currentUserName.split(' ')[0]}! 👋</h1>
              <p>Here&apos;s what&apos;s happening on Shadow today.</p>
            </div>

            <div className="stats-grid">
              {visibleStats.map((stat) => (
                <div className="stat-card" key={stat.label}>
                  <div className="stat-card-top">
                    <span className="stat-label">{stat.label}</span>
                    <div className="stat-icon-box" style={{ background: stat.iconBg }}>
                      <Icon d={stat.icon} size={18} color={stat.iconColor} />
                    </div>
                  </div>
                  <div className="stat-value" style={{ color: stat.valueColor }}>{stat.value}</div>
                  <div className="stat-trend" style={{ color: stat.trendUp ? 'var(--success)' : 'var(--danger)' }}>
                    <Icon
                      d={stat.trendUp ? 'M23 6l-9.5 9.5-5-5L1 18' : 'M23 18l-9.5-9.5-5 5L1 6'}
                      size={13}
                      color={stat.trendUp ? '#10B981' : '#EF4444'}
                    />
                    {stat.trend}
                  </div>
                </div>
              ))}
            </div>

            <div className="bento-grid">
              <section className="card-panel">
                <div className="panel-header">
                  <h4>Visitor Activity Overview</h4>
                  <span className="panel-link" onClick={() => navigate('/authors')}>View Report</span>
                </div>
                <div className="chart-wrap">
                  {chartData.map((item, index) => (
                    <div className="chart-col" key={item.day} title={`${item.day}: ${item.value.toLocaleString()}`}>
                      <span className="chart-value">{item.value.toLocaleString()}</span>
                      <div className="chart-bar-wrap">
                        <div
                          className="chart-bar"
                          style={{
                            height: `${Math.max(item.value > 0 ? 8 : 0, (item.value / maxVal) * 100)}%`,
                            background: item.active
                              ? 'linear-gradient(180deg, #4F46E5, #7C3AED)'
                              : 'linear-gradient(180deg, #6EE7B7, #D1FAE5)',
                            animationDelay: `${index * 0.08}s`,
                          }}
                        />
                      </div>
                      <span className="chart-day">{item.day}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card-panel">
                <div className="panel-header">
                  <h4>Admin Activity Log</h4>
                </div>
                <div className="log-list">
                  {activityLogLoading ? (
                    <div className="log-time">Loading activity logs...</div>
                  ) : activityLog.length === 0 ? (
                    <div className="log-time">No activity logs yet.</div>
                  ) : (
                    activityLog.map((log) => (
                      <div className="log-item" key={log.id}>
                        <div className="log-avatar" style={{ background: getLogColor(log.action) }}>
                          {getLogInitial(log)}
                        </div>
                        <div>
                          <div className="log-text">
                            <strong>{log.actor || 'Admin'}</strong> {getLogText(log)}
                          </div>
                          <div className="log-time">{formatLogTime(log.created_at)}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <button
                  type="button"
                  className="view-all-btn"
                  onClick={() => navigate('/admin/activity-logs')}
                >
                  View All Logs
                </button>
              </section>
            </div>

            <section className="card-panel">
              <div className="panel-header">
                <h4>Shadow Exclusive Workflow <span style={{ fontSize: '13px', color: '#64748B', fontWeight: 500 }}>(Real Data)</span></h4>
                <span className="panel-link" onClick={() => navigate('/shadow-exclusive')}>Open Manager</span>
              </div>
              <div className="exclusive-table-wrap">
                <table className="exclusive-table">
                  <thead>
                    <tr>
                      <th>Story Title</th>
                      <th>Episodes</th>
                      <th>Exclusive Section</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exclusiveLoading ? (
                      <tr>
                        <td colSpan={4} style={{ color: '#64748B' }}>Loading exclusive stories...</td>
                      </tr>
                    ) : exclusiveStories.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: '#64748B' }}>No pending or approved exclusive stories yet.</td>
                      </tr>
                    ) : (
                      exclusiveStories.map((story) => {
                        const status = formatExclusiveStatus(story.exclusive_status);
                        return (
                          <tr key={story.id}>
                            <td>
                              <div className="exclusive-title-cell">
                                <span
                                  className="live-dot"
                                  style={{ background: status === 'Approved' ? '#10B981' : '#F59E0B' }}
                                />
                                <span style={{ fontWeight: 600 }}>{story.title || 'Untitled story'}</span>
                              </div>
                            </td>
                            <td style={{ color: '#475569' }}>{Number(story.total_episodes || 0).toLocaleString()}</td>
                            <td style={{ color: '#475569' }}>{formatExclusiveSections(story.exclusive_sections)}</td>
                            <td>
                              <span className={`status-badge badge-${status.toLowerCase()}`}>
                                {status}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
        </div>
      </div>
    </>
  );
};

export default AdminDashboard;
