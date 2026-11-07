import { createTaskCenterAutoRotation } from './taskCenterAutoSelection.service.js'

// International keeps the existing English-only story language setting.
// Both audiences now use the same rules for all eligible stories.
const service = createTaskCenterAutoRotation({
  audience: 'international',
  language: 'English',
  historyTable: 'task_center_international_auto_story_history',
  modeField: 'international_reading_mission_mode',
  dateField: 'international_auto_last_rotation_date',
  atField: 'international_auto_last_rotated_at',
})

export const rotateTaskCenterInternationalAutoStories = service.rotate
export const ensureTaskCenterInternationalAutoRotation = service.ensure
