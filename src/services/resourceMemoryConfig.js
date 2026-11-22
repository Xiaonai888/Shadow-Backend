export const RESOURCE_MEMORY_CONFIG = Object.freeze({
  defaultContainerLimitMb: 512,
  warningMb: 300,
  protectMb: 350,
  resumeBelowMb: 280,
  criticalMb: 420,
  emergencyMb: 460,
  safetyReserveMb: 64,
  retryAfterSeconds: 30,
  jobCostsMb: Object.freeze({
    manga_page_v2: 150,
    manga_page_v1: 140,
    default: 120,
  }),
})

export function getResourceMemoryConfig() {
  return RESOURCE_MEMORY_CONFIG
}
