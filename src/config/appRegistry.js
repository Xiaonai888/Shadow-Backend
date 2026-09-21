export const APP_REGISTRY = Object.freeze([
  Object.freeze({
    appKey: 'shadow-studio',
    name: 'Shadow Studio',
    profile: null,
    hidden: false,
    disabled: false,
  }),
  Object.freeze({
    appKey: 'shadow-docs',
    name: 'Shadow Docs',
    profile: null,
    hidden: true,
    disabled: true,
  }),
])

export function getAppDefinition(appKey) {
  const key = String(appKey || '').trim()
  return APP_REGISTRY.find((app) => app.appKey === key) || null
}
