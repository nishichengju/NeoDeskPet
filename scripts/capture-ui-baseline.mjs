import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(projectRoot, 'artifacts', 'ui-baseline')
const browsersPath = path.join(projectRoot, 'playwright-browsers')
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const baseUrl = 'http://127.0.0.1:4173'

process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
mkdirSync(outputDir, { recursive: true })

const preview = spawn(process.execPath, [viteCli, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let previewOutput = ''
preview.stdout.on('data', (chunk) => {
  previewOutput += String(chunk)
})
preview.stderr.on('data', (chunk) => {
  previewOutput += String(chunk)
})

async function waitForPreview() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (preview.exitCode != null) throw new Error(`Vite preview exited early.\n${previewOutput}`)
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for Vite preview.\n${previewOutput}`)
}

function installOrbPanelMock(page) {
  return page.addInitScript(() => {
    const now = Date.now()
    const summary = {
      id: 'baseline-session',
      name: '界面基线会话',
      personaId: 'default',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    const session = { ...summary, nameMode: 'manual', messages: [] }
    const off = () => undefined
    const api = {
      getOrbUiState: async () => ({ state: 'panel' }),
      onOrbStateChanged: () => off,
      getSettings: async () => ({ activePersonaId: 'default' }),
      onSettingsChanged: () => off,
      listChatSessions: async () => ({ sessions: [summary], currentSessionId: summary.id }),
      createChatSession: async () => session,
      setCurrentChatSession: async () => summary,
      getChatSession: async () => session,
      listTasks: async () => ({ items: [] }),
      onTasksChanged: () => off,
      setOrbUiState: async (state) => ({ state }),
      setOrbOverlayBounds: async () => ({ ok: true }),
      clearOrbOverlayBounds: async () => ({ ok: true }),
      getChatAttachmentUrl: async () => ({ ok: false, url: '' }),
    }
    Object.defineProperty(window, 'neoDeskPet', { configurable: true, value: api })
  })
}

function installMemoryMock(page) {
  return page.addInitScript(() => {
    const now = Date.now()
    const settings = {
      activePersonaId: 'default',
      memory: {
        enabled: true,
        includeSharedOnRetrieve: true,
        autoExtractEnabled: false,
        autoExtractEveryEffectiveMessages: 20,
      },
      memoryConsole: {
        personaId: 'default',
        scope: 'persona',
        role: 'all',
        query: '',
        status: 'active',
        pinned: 'all',
        source: 'all',
        memoryType: 'all',
        orderBy: 'createdAt',
        orderDir: 'desc',
        limit: 50,
        autoRefresh: false,
        extractSessionId: 'baseline-session',
        extractMaxMessages: 30,
        extractWriteToSelectedPersona: false,
        extractSaveScope: 'model',
      },
    }
    const persona = {
      id: 'default',
      name: '默认桌宠',
      prompt: '',
      captureEnabled: true,
      captureUser: true,
      captureAssistant: true,
      retrieveEnabled: true,
      createdAt: now,
      updatedAt: now,
    }
    const sessionSummary = {
      id: 'baseline-session',
      name: '界面基线会话',
      personaId: 'default',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    const off = () => undefined
    const api = {
      getSettings: async () => settings,
      onSettingsChanged: () => off,
      listPersonas: async () => [{ id: persona.id, name: persona.name, updatedAt: now }],
      getPersona: async () => persona,
      listChatSessions: async () => ({ sessions: [sessionSummary], currentSessionId: sessionSummary.id }),
      getChatSession: async () => ({ ...sessionSummary, messages: [] }),
      listMemory: async () => ({
        total: 1,
        items: [
          {
            rowid: 1,
            personaId: 'default',
            scope: 'persona',
            kind: 'note',
            role: 'note',
            content: '这是一条用于固定界面布局的基线记忆。',
            createdAt: now,
            updatedAt: now,
            importance: 0.8,
            strength: 1,
            accessCount: 0,
            lastAccessedAt: null,
            retention: 1,
            status: 'active',
            memoryType: 'semantic',
            source: 'baseline',
            pinned: 0,
          },
        ],
      }),
      listMemoryConflicts: async () => ({ total: 0, items: [] }),
      setMemoryConsoleSettings: async () => settings,
      openSettings: async () => undefined,
      closeCurrent: async () => undefined,
    }
    Object.defineProperty(window, 'neoDeskPet', { configurable: true, value: api })
  })
}

const baselines = [
  { name: 'chat-default-720x620-scale100', route: 'chat', width: 720, height: 620, scale: 1, compactChat: true },
  { name: 'settings-default-860x680-scale100', route: 'settings', width: 860, height: 680, scale: 1 },
  { name: 'memory-default-900x720-scale100', route: 'memory', width: 900, height: 720, scale: 1, mockMemory: true },
  { name: 'orb-panel-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbPanel: true },
  { name: 'chat-min-520x500-scale100', route: 'chat', width: 520, height: 500, scale: 1, compactChat: true, expandChat: true },
  { name: 'settings-min-640x500-scale100', route: 'settings', width: 640, height: 500, scale: 1, verifySettingsTabs: true },
  { name: 'memory-min-640x500-scale100', route: 'memory', width: 640, height: 500, scale: 1, mockMemory: true },
  { name: 'chat-default-720x620-scale125', route: 'chat', width: 720, height: 620, scale: 1.25, compactChat: true },
  { name: 'settings-default-860x680-scale125', route: 'settings', width: 860, height: 680, scale: 1.25 },
  { name: 'memory-default-900x720-scale125', route: 'memory', width: 900, height: 720, scale: 1.25, mockMemory: true },
  { name: 'chat-default-720x620-scale150', route: 'chat', width: 720, height: 620, scale: 1.5, compactChat: true },
  { name: 'settings-default-860x680-scale150', route: 'settings', width: 860, height: 680, scale: 1.5 },
  { name: 'memory-default-900x720-scale150', route: 'memory', width: 900, height: 720, scale: 1.5, mockMemory: true },
]

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  items: [],
}

let browser
try {
  await waitForPreview()
  const { chromium } = await import('playwright-core')
  browser = await chromium.launch({ headless: true })

  for (const baseline of baselines) {
    const context = await browser.newContext({
      viewport: { width: baseline.width, height: baseline.height },
      deviceScaleFactor: baseline.scale,
    })
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))
    if (baseline.mockOrbPanel) await installOrbPanelMock(page)
    if (baseline.mockMemory) await installMemoryMock(page)

    await page.goto(`${baseUrl}/#/${baseline.route}`, { waitUntil: 'networkidle' })
    await page.locator('#root > *').waitFor({ state: 'visible' })
    await page.waitForTimeout(350)

    const screenshotPath = path.join(outputDir, `${baseline.name}.png`)
    await page.screenshot({ path: screenshotPath })
    const metrics = await page.evaluate(() => {
      const settingsTabs = document.querySelector('.ndp-settings-tabs')
      const chatSummary = document.querySelector('.ndp-chat-membar-summary')
      const chatDetails = document.querySelector('.ndp-chat-membar-details')
      return {
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        body: { scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight },
        horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth,
        verticalOverflow: document.body.scrollHeight > document.documentElement.clientHeight,
        settingsTabs: settingsTabs
          ? {
              clientWidth: settingsTabs.clientWidth,
              scrollWidth: settingsTabs.scrollWidth,
              overflowX: getComputedStyle(settingsTabs).overflowX,
            }
          : null,
        chatStatus: chatSummary && chatDetails
          ? {
              summaryVisible: getComputedStyle(chatSummary).display !== 'none',
              detailsVisible: getComputedStyle(chatDetails).display !== 'none',
            }
          : null,
      }
    })

    const failures = []
    if (metrics.horizontalOverflow) failures.push('body has horizontal overflow')
    if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`)
    if (baseline.compactChat && !metrics.chatStatus?.summaryVisible) {
      failures.push('compact chat status summary is not visible')
    }
    if (baseline.compactChat && metrics.chatStatus?.detailsVisible) {
      failures.push('compact chat status details are expanded by default')
    }
    if (baseline.route === 'settings' && metrics.settingsTabs?.overflowX !== 'auto') {
      failures.push('settings tabs are not horizontally scrollable')
    }

    let expandedChat = null
    if (baseline.expandChat) {
      await page.locator('.ndp-chat-membar-summary').click()
      await page.waitForTimeout(100)
      const expandedScreenshotPath = path.join(outputDir, `${baseline.name}-expanded.png`)
      const expandedScreenshot = path.relative(projectRoot, expandedScreenshotPath)
      await page.screenshot({ path: expandedScreenshotPath })
      expandedChat = await page.evaluate(() => {
        const details = document.querySelector('.ndp-chat-membar-details')
        const messages = document.querySelector('.ndp-chat-messages')
        if (!details || !messages) return null
        const detailsRect = details.getBoundingClientRect()
        const messagesRect = messages.getBoundingClientRect()
        return {
          detailsVisible: getComputedStyle(details).display !== 'none',
          detailsHeight: detailsRect.height,
          messagesHeight: messagesRect.height,
          horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth,
        }
      })
      if (expandedChat) expandedChat.screenshot = expandedScreenshot
      if (!expandedChat?.detailsVisible) failures.push('compact chat status details did not expand')
      if ((expandedChat?.detailsHeight ?? Number.POSITIVE_INFINITY) > 260) {
        failures.push(`compact chat status details are too tall: ${expandedChat?.detailsHeight}`)
      }
      if ((expandedChat?.messagesHeight ?? 0) < 100) {
        failures.push(`compact chat messages area is too short after expansion: ${expandedChat?.messagesHeight}`)
      }
      if (expandedChat?.horizontalOverflow) failures.push('expanded compact chat has horizontal overflow')
    }

    let settingsTabNavigation = null
    if (baseline.verifySettingsTabs) {
      const tabButtons = page.locator('.ndp-settings-tabs .ndp-tab-btn')
      const tabCount = await tabButtons.count()
      const lastTab = tabButtons.last()
      await lastTab.scrollIntoViewIfNeeded()
      await lastTab.click()
      await page.waitForTimeout(100)
      const tabsEndScreenshotPath = path.join(outputDir, `${baseline.name}-tabs-end.png`)
      const tabsEndScreenshot = path.relative(projectRoot, tabsEndScreenshotPath)
      await page.screenshot({ path: tabsEndScreenshotPath })
      settingsTabNavigation = await page.evaluate(() => {
        const tabs = document.querySelector('.ndp-settings-tabs')
        const active = document.querySelector('.ndp-settings-tabs .ndp-tab-btn.active')
        if (!tabs || !active) return null
        const tabsRect = tabs.getBoundingClientRect()
        const activeRect = active.getBoundingClientRect()
        return {
          activeLabel: active.textContent?.trim() ?? '',
          activeVisible: activeRect.left >= tabsRect.left - 1 && activeRect.right <= tabsRect.right + 1,
          scrollLeft: tabs.scrollLeft,
        }
      })
      if (settingsTabNavigation) settingsTabNavigation.screenshot = tabsEndScreenshot
      if (tabCount < 2) failures.push('settings tab navigation has fewer than two entries')
      if (!settingsTabNavigation?.activeVisible) failures.push('last settings tab is not visible after navigation')
      if ((settingsTabNavigation?.scrollLeft ?? 0) <= 0) failures.push('settings tabs did not scroll to the last entry')
    }

    report.items.push({
      ...baseline,
      screenshot: path.relative(projectRoot, screenshotPath),
      metrics,
      expandedChat,
      settingsTabNavigation,
      consoleErrors,
      failures,
    })
    await context.close()
  }

  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const failures = report.items.flatMap((item) => item.failures.map((failure) => `${item.name}: ${failure}`))
  if (failures.length > 0) throw new Error(`UI baseline failed:\n${failures.join('\n')}`)
  console.log(`[UI baseline] wrote ${report.items.length} screenshots to ${outputDir}`)
} finally {
  if (browser) await browser.close()
  if (preview.exitCode == null) preview.kill()
}
