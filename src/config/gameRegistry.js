export const GAME_REGISTRY = Object.freeze([
  Object.freeze({
    gameKey: 'spin',
    name: 'Spin',
    profile: null,
    hidden: false,
    disabled: false,
   }),
  Object.freeze({
    gameKey: 'test',
    name: 'Test',
    profile: null,
    hidden: false,
    disabled: true,
  }),
  Object.freeze({
    gameKey: 'shadow-realms',
    name: 'Shadow Realms',
    profile: null,
    hidden: true,
    disabled: true,
  }),
])

export function getGameDefinition(gameKey) {
  const key = String(gameKey || '').trim()
  return GAME_REGISTRY.find((game) => game.gameKey === key) || null
}
