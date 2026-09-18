export const APP_REGISTRY = Object.freeze([
  Object.freeze({
    appKey: 'shadow-studio',
    name: 'Shadow Studio',
    profile: null,
    hidden: false,
    disabled: false,
  }),
])

export function getAppDefinition(appKey) {
  const key = String(appKey || '').trim()
  return APP_REGISTRY.find((app) => app.appKey === key) || null
}
