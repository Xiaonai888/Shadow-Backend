export const GAME_REGISTRY = Object.freeze([
  Object.freeze({
    gameKey: 'spin',
    name: 'Spin',
    profile: null,
    hidden: false,
    disabled: false,
  }),
])

export function getGameDefinition(gameKey) {
  const key = String(gameKey || '').trim()
  return GAME_REGISTRY.find((game) => game.gameKey === key) || null
}
