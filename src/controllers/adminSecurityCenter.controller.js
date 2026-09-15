import { supabase } from '../config/supabase.js'
import { getSecurityControlSnapshot } from '../services/securityControlPlane.service.js'
import { getSecurityResponseAssistantSnapshot } from '../services/securityResponseAssistant.service.js'
import { getIpsSnapshot } from '../services/ipsCore.service.js'
import { getTamperGuardSnapshot } from '../services/tamperGuard.service.js'
import { getSecurityGateSnapshot } from '../middleware/securityGate.middleware.js'
import { getActiveWorkKillSwitchSnapshot } from '../services/workKillSwitch.service.js'
import { listWorkIncidents } from '../services/workIncident.service.js'

const ACTIVE_STATES = new Set([
  'awake',
  'defending',
  'restricted',
  'blocked',
  'isolated',
  'critical',
  'safe_mode',
])

function findGuard(snapshot, key) {
  return snapshot.guards.find((item) => item.guard === key) || null
}

function countPendingResponses(assistant) {
  return assistant.responses.filter((item) => item.status === 'pending').length
}

function statusForIps(state) {
  if (state === 'isolated') return ['Isolating', 'danger']
  if (state === 'blocked') return ['Blocking', 'danger']
  if (state === 'defending' || state === 'restricted') return ['Defending', 'warning']
  if (state === 'awake') return ['Awake', 'warning']
  if (state === 'offline') return ['Offline', 'danger']
  return ['Sleeping', 'neutral']
}

function statusForSpam(state) {
  if (state === 'degraded' || state === 'offline') return ['Degraded', 'danger']
  if (ACTIVE_STATES.has(state)) return ['Restricting', 'warning']
  return ['Healthy', 'success']
}

function statusForGate(state) {
  if (state === 'offline') return ['Offline', 'danger']
  if (state === 'defending' || state === 'blocked' || state === 'restricted') {
    return ['Denying', 'warning']
  }
  if (state === 'safe_mode' || state === 'critical') return ['Protected', 'danger']
  return ['Healthy', 'success']
}

function statusForTamper(state, activeCount) {
  if (activeCount > 0 || state === 'critical') return ['Incident', 'danger']
  if (state === 'offline') return ['Offline', 'danger']
  return ['Protected', 'success']
}

function titleCase(value) {
  return String(value || 'Security event')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function signalTitle(event) {
  const titles = {
    tamper_attempt_detected: 'Tamper attempt detected',
    route_incident_active: 'Route incident detected',
    route_incident_reopened: 'Route incident reopened',
    kill_switch_enabled: 'Kill switch activated',
    kill_switch_disabled: 'Kill switch released',
    kill_switch_expiry_failed: 'Kill switch expiry failed',
    spam_guard_blocked: 'Spam Guard restriction applied',
    spam_guard_degraded: 'Spam Guard degraded',
    security_gate_denied: 'Security Gate denied access',
    ips_defense_started: 'IPS defense started',
    ips_defense_escalated: 'IPS defense escalated',
    security_response_action_executed: 'Security response executed',
    security_response_action_failed: 'Security response failed',
    security_response_created: 'Security response created',
    safe_mode_entered: 'Safe Mode activated',
    normal_mode_restored: 'Normal mode restored',
  }

  return titles[event.type] || titleCase(event.type)
}

function signalDetail(event) {
  const payload = event.payload || {}

  return String(
    payload.path
      || payload.reason
      || payload.target
      || payload.scope
      || event.source
      || 'Security system'
  ).slice(0, 180)
}

async function getActiveLoginBlockCount() {
  const now = new Date().toISOString()

  const { count, error } = await supabase
    .from('admin_guard_state')
    .select('id', { count: 'exact', head: true })
    .or(`blocked_until.gt.${now},is_permanent_blocked.eq.true`)

  if (error) throw error
  return Math.max(Number(count) || 0, 0)
}

async function getActiveWorkIncidentCount() {
  const result = await listWorkIncidents({
    status: 'active',
    page: 1,
    limit: 1,
  })

  return Math.max(Number(result.pagination?.total) || 0, 0)
}

export async function getAdminSecurityCenter(req, res) {
  const control = getSecurityControlSnapshot()
  const assistant = getSecurityResponseAssistantSnapshot()
  const ips = getIpsSnapshot()
  const tamper = getTamperGuardSnapshot()
  const gate = getSecurityGateSnapshot()
  const activeKillSwitches = getActiveWorkKillSwitchSnapshot()

  const [workResult, loginResult] = await Promise.allSettled([
    getActiveWorkIncidentCount(),
    getActiveLoginBlockCount(),
  ])

  const workIncidents =
    workResult.status === 'fulfilled' ? workResult.value : null
  const loginBlocks =
    loginResult.status === 'fulfilled' ? loginResult.value : null

  if (workResult.status === 'rejected') {
    console.error(
      'SECURITY_CENTER_WORK_COUNT_ERROR:',
      workResult.reason?.message || workResult.reason
    )
  }

  if (loginResult.status === 'rejected') {
    console.error(
      'SECURITY_CENTER_LOGIN_COUNT_ERROR:',
      loginResult.reason?.message || loginResult.reason
    )
  }

  const ipsControl = findGuard(control, 'ips')
  const spamControl = findGuard(control, 'spam_guard')
  const gateControl = findGuard(control, 'security_gate')
  const tamperControl = findGuard(control, 'tamper_guard')

  const ipsState = ipsControl?.state || ips.state || 'sleeping'
  const spamState = spamControl?.state || 'monitoring'
  const gateState = gateControl?.state || gate.state || 'monitoring'
  const tamperState = tamperControl?.state || tamper.state || 'sleeping'

  const [ipsStatus, ipsTone] = statusForIps(ipsState)
  const [spamStatus, spamTone] = statusForSpam(spamState)
  const [gateStatus, gateTone] = statusForGate(gateState)
  const [tamperStatus, tamperTone] = statusForTamper(
    tamperState,
    tamper.active_count
  )

  const pendingResponses = countPendingResponses(assistant)
  const assistantStatus = pendingResponses > 0
    ? 'Waiting Review'
    : assistant.state === 'awake'
      ? 'Responding'
      : assistant.started
        ? 'Sleeping'
        : 'Offline'
  const assistantTone = !assistant.started
    ? 'danger'
    : pendingResponses > 0
      ? 'warning'
      : assistant.state === 'awake'
        ? 'info'
        : 'neutral'

  const loginStatus = loginBlocks === null
    ? 'Unavailable'
    : loginBlocks > 0
      ? 'Alert'
      : 'Healthy'
  const loginTone = loginBlocks === null
    ? 'neutral'
    : loginBlocks > 0
      ? 'danger'
      : 'success'

  const safeMode = control.control.mode === 'safe_mode'

  const guards = [
    {
      key: 'ips',
      name: 'IPS',
      state: ipsState,
      status: ipsStatus,
      tone: ipsTone,
      description: 'Stops hostile identities and suspicious requests',
      detail: `${ips.active_count} active defense${ips.active_count === 1 ? '' : 's'}`,
      active: ACTIVE_STATES.has(ipsState),
      updated_at: ipsControl?.updated_at || null,
    },
    {
      key: 'spam_guard',
      name: 'Spam Guard',
      state: spamState,
      status: spamStatus,
      tone: spamTone,
      description: 'Controls spam and restriction cooldowns',
      detail: `${Number(spamControl?.details?.active_restrictions || 0)} active restriction${Number(spamControl?.details?.active_restrictions || 0) === 1 ? '' : 's'}`,
      active: ACTIVE_STATES.has(spamState) || spamState === 'degraded',
      updated_at: spamControl?.updated_at || null,
    },
    {
      key: 'security_gate',
      name: 'Security Gate',
      state: gateState,
      status: gateStatus,
      tone: gateTone,
      description: 'Protects sensitive admin actions',
      detail: `${gate.registered_count} registered gate${gate.registered_count === 1 ? '' : 's'}`,
      active: ACTIVE_STATES.has(gateState),
      updated_at: gateControl?.updated_at || null,
    },
    {
      key: 'tamper_guard',
      name: 'Tamper Guard',
      state: tamperState,
      status: tamperStatus,
      tone: tamperTone,
      description: 'Guards the guards and watches security mutations',
      detail: `${tamper.active_count} active incident${tamper.active_count === 1 ? '' : 's'}`,
      active: tamper.active_count > 0 || ACTIVE_STATES.has(tamperState),
      updated_at: tamperControl?.updated_at || null,
    },
    {
      key: 'control_plane',
      name: 'Control Plane',
      state: control.control.mode,
      status: safeMode ? 'Safe Mode' : 'Online',
      tone: safeMode ? 'danger' : 'info',
      description: 'Central event bus and security state hub',
      detail: safeMode
        ? control.control.reason || 'Protected state active'
        : 'Normal operation',
      active: safeMode,
      updated_at: control.control.changed_at || null,
    },
    {
      key: 'response_assistant',
      name: 'Response Assistant',
      state: assistant.state,
      status: assistantStatus,
      tone: assistantTone,
      description: 'Coordinates response playbooks and manual resolution',
      detail: `${pendingResponses} item${pendingResponses === 1 ? '' : 's'} in response queue`,
      active: assistant.state === 'awake' || pendingResponses > 0,
      updated_at: assistant.responses[0]?.updated_at || null,
    },
    {
      key: 'sensitive_path_guard',
      name: 'Sensitive Path Guard',
      state: 'monitoring',
      status: 'Protected',
      tone: 'success',
      description: 'Blocks probes for .env, .git, backups, and private paths',
      detail: 'Mounted before application routes',
      active: false,
      updated_at: null,
    },
    {
      key: 'login_guard',
      name: 'Login Guard',
      state: loginBlocks > 0 ? 'defending' : 'monitoring',
      status: loginStatus,
      tone: loginTone,
      description: 'Monitors risky login and access changes',
      detail: loginBlocks === null
        ? 'Login Guard count unavailable'
        : `${loginBlocks} active login block${loginBlocks === 1 ? '' : 's'}`,
      active: Number(loginBlocks || 0) > 0,
      updated_at: null,
    },
  ]

  const recentSignals = control.recent_events
    .slice(0, 8)
    .map((event) => ({
      id: event.event_id,
      source: event.source,
      type: event.type,
      severity: event.severity,
      title: signalTitle(event),
      detail: signalDetail(event),
      created_at: event.created_at,
    }))

  return res.status(200).json({
    ok: true,
    generated_at: Date.now(),
    summary: {
      total_guards: guards.length,
      active_defenses: guards.filter((guard) => guard.active).length,
      pending_approvals: pendingResponses,
      safe_mode: safeMode,
    },
    guards,
    recent_signals: recentSignals,
    quick_view: {
      work_incidents: workIncidents,
      kill_switches: activeKillSwitches.length,
      response_queue: pendingResponses,
    },
  })
}
