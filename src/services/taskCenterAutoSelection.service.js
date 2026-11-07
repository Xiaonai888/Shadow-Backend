import { createTaskCenterAutoRotation } from './taskCenterAutoSelection.service.js'

// Khmer and International share exactly the same selection and rotation logic.
// Only audience, story language, history and settings columns differ.
const service = createTaskCenterAutoRotation({
  audience: 'khmer',
  language: 'Khmer',
  historyTable: 'task_center_auto_story_history',
  modeField: 'reading_mission_mode',
  dateField: 'auto_last_rotation_date',
  atField: 'auto_last_rotated_at',
})

export const rotateTaskCenterAutoStories = service.rotate
export const ensureTaskCenterAutoRotation = service.ensure
