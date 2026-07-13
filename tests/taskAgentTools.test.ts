import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../electron/toolRegistry'
import {
  buildToolResultBlock,
  findLastCompleteToolRequestEnd,
  makeToolCallKey,
  stableStringify,
  stripToolRequestBlocksForDisplay,
  TaskAgentToolCatalog,
  TOOL_REQUEST_END,
  TOOL_REQUEST_START,
} from '../electron/task/taskAgentTools'

function tool(name: string, callName: string, description = `${name} description`): ToolDefinition {
  return {
    name,
    callName,
    description,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    examples: [],
    risk: 'low',
    cost: 'low',
    tags: [],
    version: '1',
  }
}

function createCatalog(): TaskAgentToolCatalog {
  return new TaskAgentToolCatalog([
    tool('browser.fetch', 'ndp_browser_fetch'),
    tool('browser.open', 'ndp_browser_open'),
    tool('skill.read', 'ndp_skill_read'),
  ])
}

describe('Task agent tool catalog', () => {
  it('resolves native call names, provider prefixes, and internal names', () => {
    const catalog = createCatalog()

    expect(catalog.resolveCallName('ndp_browser_fetch')?.name).toBe('browser.fetch')
    expect(catalog.resolveCallName('default_api:ndp_browser_fetch')?.name).toBe('browser.fetch')
    expect(catalog.resolveCallName('browser.fetch')?.callName).toBe('ndp_browser_fetch')
    expect(catalog.resolveCallName('missing')).toBeNull()
  })

  it('normalizes weak-model protocol noise and legacy fetch aliases', () => {
    const catalog = createCatalog()
    const direct = catalog.resolveTextName('tool_name: `「browser.fetch」始`')
    const aliased = catalog.resolveTextName('「始」MCP.FETCH.FETCH「末」')

    expect(direct).toMatchObject({ cleanedName: 'browser.fetch', effectiveName: 'browser.fetch', aliasApplied: false })
    expect(aliased).toMatchObject({
      cleanedName: 'MCP.FETCH.FETCH',
      effectiveName: 'browser.fetch',
      aliasApplied: true,
    })
    expect(aliased.def?.name).toBe('browser.fetch')
  })

  it('suggests matching internal and native tool names without duplicates', () => {
    const suggestions = createCatalog().suggestNames('browser')

    expect(suggestions).toEqual(['browser.fetch', 'browser.open'])
  })

  it('parses complete text requests, JSON inputs, aliases, and surrounding prose', () => {
    const catalog = createCatalog()
    const text = [
      'before',
      TOOL_REQUEST_START,
      'tool_name:「始」mcp.fetch.fetch「末」',
      'input_json:「始」{"url":"https://example.com","stripHtml":true}「末」',
      TOOL_REQUEST_END,
      'between',
      '<<[TOOL_REQUEST]>>',
      'tool_name:「始」skill.read「末」',
      'input_json:「始」plain-input「末」',
      '<<[END_TOOL_REQUEST]>>',
      'after',
    ].join('\n')

    const parsed = catalog.parseTextRequests(text)

    expect(parsed.cleaned).toContain('before')
    expect(parsed.cleaned).toContain('between')
    expect(parsed.cleaned).toContain('after')
    expect(parsed.cleaned).not.toContain('TOOL_REQUEST')
    expect(parsed.calls).toEqual([
      {
        toolName: 'browser.fetch',
        rawToolName: 'mcp.fetch.fetch',
        cleanedToolName: 'mcp.fetch.fetch',
        aliasApplied: true,
        input: { url: 'https://example.com', stripHtml: true },
      },
      {
        toolName: 'skill.read',
        rawToolName: undefined,
        cleanedToolName: undefined,
        aliasApplied: false,
        input: 'plain-input',
      },
    ])
  })

  it('hides incomplete protocol tails from display and stops at the last complete block', () => {
    const complete = `${TOOL_REQUEST_START}\ntool_name:「始」browser.fetch「末」\n${TOOL_REQUEST_END}`
    const text = `visible${complete}middle${TOOL_REQUEST_START}hidden`
    const end = findLastCompleteToolRequestEnd(text)

    expect(text.slice(0, end)).toBe(`visible${complete}`)
    expect(stripToolRequestBlocksForDisplay(text)).toBe('visiblemiddle')
    expect(createCatalog().parseTextRequests(text).cleaned).toContain(`${TOOL_REQUEST_START}hidden`)
  })

  it('builds deterministic call keys, result blocks, and text-mode guidance', () => {
    const first = { z: 1, nested: { b: true, a: 'x' } }
    const second = { nested: { a: 'x', b: true }, z: 1 }
    const catalog = createCatalog()
    const guide = catalog.buildTextModeGuide('custom image rule')

    expect(stableStringify(first)).toBe(stableStringify(second))
    expect(makeToolCallKey('browser.fetch', first)).toBe(makeToolCallKey('browser.fetch', second))
    expect(buildToolResultBlock('browser.fetch', 'ok')).toContain('result:「始」ok「末」')
    expect(guide).toContain('custom image rule')
    expect(guide).toContain('- browser.fetch：browser.fetch description')
    expect(guide).toContain(TOOL_REQUEST_START)
  })
})
