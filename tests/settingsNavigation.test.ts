import { describe, expect, it } from 'vitest'
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ENTRIES,
  searchSettings,
} from '../src/windows/settings/settingsNavigation'

describe('settings navigation', () => {
  it('keeps every navigation view unique and reachable in one click', () => {
    const ids = SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('aiConnection')
    expect(ids).toContain('asr')
    expect(ids).toContain('worldBook')
    expect(SETTINGS_SEARCH_ENTRIES.every((entry) => ids.includes(entry.view))).toBe(true)
  })

  it.each([
    ['密钥', 'api-key'],
    ['endpoint', 'api-base-url'],
    ['人物', 'persona'],
    ['麦克风', 'asr'],
    ['知识库', 'world-book'],
    ['逐字', 'streaming'],
    ['向量', 'memory-vector'],
  ])('finds common alias %s', (query, expectedId) => {
    expect(searchSettings(query).map((entry) => entry.id)).toContain(expectedId)
  })

  it('requires every term in a multi-word search', () => {
    expect(searchSettings('api 模型')[0]?.id).toBe('api-model')
    expect(searchSettings('')).toEqual([])
  })
})
