export function buildMemoryFtsQuery(text: string): string | null {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  if (!cleaned) return null

  const shouldSplitCharacters =
    !/\s/.test(cleaned) &&
    cleaned.length >= 2 &&
    /\p{Script=Han}/u.test(cleaned) &&
    !/[A-Za-z]/.test(cleaned)
  if (shouldSplitCharacters) {
    const characters = Array.from(cleaned)
      .map((character) => character.trim())
      .filter(Boolean)
      .filter((character) => /[\p{L}\p{N}]/u.test(character))
      .slice(0, 12)

    if (characters.length >= 2) {
      return characters.map((character) => `"${character.replace(/"/g, '')}"`).join(' OR ')
    }
  }

  const tokens = cleaned
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((token) => token.replace(/"/g, ''))
    .filter(Boolean)

  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token}"`).join(' OR ')
}
