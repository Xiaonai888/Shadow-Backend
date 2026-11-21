const POLICIES = Object.freeze({
  manga_page_v2: Object.freeze({
    jobType: 'manga_page_v2',
    label: 'Manga page processing',
    lane: 'heavy_media',
    mode: 'on_demand',
    priority: 90,
    estimatedJobMb: 150,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  story_image_pipeline: Object.freeze({
    jobType: 'story_image_pipeline',
    label: 'Story image processing',
    lane: 'heavy_media',
    mode: 'on_demand',
    priority: 85,
    estimatedJobMb: 120,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  story_episode_push: Object.freeze({
    jobType: 'story_episode_push',
    label: 'Scheduled story publishing',
    lane: 'light_background',
    mode: 'scheduled',
    priority: 70,
    estimatedJobMb: 30,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  author_story_push: Object.freeze({
    jobType: 'author_story_push',
    label: 'Author story notifications',
    lane: 'light_background',
    mode: 'scheduled',
    priority: 65,
    estimatedJobMb: 30,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  cleanup_retention: Object.freeze({
    jobType: 'cleanup_retention',
    label: 'Retention cleanup',
    lane: 'maintenance',
    mode: 'scheduled',
    priority: 30,
    estimatedJobMb: 40,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  smart_ad_maintenance: Object.freeze({
    jobType: 'smart_ad_maintenance',
    label: 'Smart Ad maintenance',
    lane: 'maintenance',
    mode: 'scheduled',
    priority: 25,
    estimatedJobMb: 40,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
  system_usage_persistence: Object.freeze({
    jobType: 'system_usage_persistence',
    label: 'Resource usage persistence',
    lane: 'maintenance',
    mode: 'scheduled',
    priority: 20,
    estimatedJobMb: 40,
    safetyReserveMb: 64,
    maxParallel: 1,
    schedulable: true,
    stopWhenFinished: true,
  }),
})

const UNKNOWN_POLICY = Object.freeze({
  jobType: 'unknown',
  label: 'Unregistered background job',
  lane: 'unregistered',
  mode: 'unregistered',
  priority: 0,
  estimatedJobMb: 0,
  safetyReserveMb: 64,
  maxParallel: 0,
  schedulable: false,
  stopWhenFinished: false,
})

export function getResourcePolicy(jobType) {
  const key = String(jobType || '').trim()
  return POLICIES[key] || UNKNOWN_POLICY
}

export function listResourcePolicies() {
  return Object.values(POLICIES).map((policy) => ({ ...policy }))
}

export function isResourceJobRegistered(jobType) {
  return getResourcePolicy(jobType).schedulable === true
}
