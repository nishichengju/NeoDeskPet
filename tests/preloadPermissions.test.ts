import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PRELOAD_API_METHODS, parsePreloadWindowType, pickPreloadApi } from '../electron/preloadPermissions'

function collectApiMethods(files: readonly string[]): string[] {
  const methods = new Set<string>()
  for (const file of files) {
    const sourceText = fs.readFileSync(path.resolve(file), 'utf8')
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const expression = node.expression.getText(source)
        if (expression === 'api' || expression === 'probeApi' || expression === 'window.neoDeskPet') {
          methods.add(node.name.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...methods].sort()
}

describe('preload capability filtering', () => {
  it('accepts only known main-process window arguments', () => {
    expect(parsePreloadWindowType(['electron', '--neodeskpet-window-type=chat'])).toBe('chat')
    expect(parsePreloadWindowType(['electron', '--neodeskpet-window-type=remote'])).toBeNull()
    expect(parsePreloadWindowType(['electron'])).toBeNull()
  })

  it('does not expose settings, media, or quit capabilities to unrelated windows', () => {
    const api = {
      getSettings: () => undefined,
      setAISettings: () => undefined,
      getChatAttachmentUrl: () => undefined,
      quit: () => undefined,
      closeCurrent: () => undefined,
    }

    expect(Object.keys(pickPreloadApi(api, 'chat')).sort()).toEqual(['closeCurrent', 'getChatAttachmentUrl', 'getSettings'])
    expect(Object.keys(pickPreloadApi(api, 'settings')).sort()).toEqual(['closeCurrent', 'getSettings', 'setAISettings'])
    expect(Object.keys(pickPreloadApi(api, 'memory')).sort()).toEqual(['closeCurrent', 'getSettings'])
    expect(Object.keys(pickPreloadApi(api, 'orb-menu')).sort()).toEqual(['closeCurrent', 'getSettings', 'quit'])
  })

  it('keeps the Orb chat handoff and attachment preview workflow available', () => {
    expect(PRELOAD_API_METHODS.orb).toContain('openChat')
    expect(PRELOAD_API_METHODS.orb).toContain('readChatAttachmentDataUrl')
  })

  it('covers every preload method used by each window implementation', () => {
    const settingsFiles = fs
      .readdirSync(path.resolve('src/windows/settings'))
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => `src/windows/settings/${name}`)
    const routeFiles = {
      pet: [
        'src/windows/PetWindow.tsx',
        'src/live2d/Live2DView.tsx',
        'src/live2d/live2dModels.ts',
        'src/services/ttsService.ts',
      ],
      chat: ['src/windows/ChatWindow.tsx', 'src/components/MarkdownMessage.tsx', 'src/components/MediaPreviews.tsx'],
      settings: ['src/windows/SettingsWindow.tsx', ...settingsFiles],
      memory: ['src/windows/MemoryConsoleWindow.tsx'],
      orb: ['src/orb/OrbApp.tsx'],
      'orb-menu': ['src/orb/OrbMenuWindow.tsx'],
    } as const

    for (const [windowType, files] of Object.entries(routeFiles)) {
      const allowed = new Set(PRELOAD_API_METHODS[windowType as keyof typeof PRELOAD_API_METHODS])
      const missing = collectApiMethods(files).filter((method) => !allowed.has(method))
      expect(missing, `${windowType} is missing preload methods`).toEqual([])
    }
  })
})
