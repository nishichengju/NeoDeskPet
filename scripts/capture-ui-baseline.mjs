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

function installSettingsMock(page) {
  return page.addInitScript(() => {
    const settings = {
      activePersonaId: 'default',
      aiProfiles: [],
      activeAiProfileId: '',
      worldBook: {
        enabled: true,
        activeTagIds: [],
        maxChars: 6000,
        entries: [
          {
            id: 'baseline-world-book',
            title: '界面基线设定',
            content: '用于确认危险操作对话框。',
            tags: [],
            enabled: true,
            scope: 'global',
            priority: 100,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
    }
    const off = () => undefined
    const api = new Proxy(
      {
        getSettings: async () => settings,
        onSettingsChanged: () => off,
        scanModels: async () => [],
        listPersonas: async () => [],
        listMemory: async () => ({ total: 0, items: [] }),
        openMemory: async () => undefined,
        closeCurrent: async () => undefined,
      },
      {
        get(target, property) {
          if (property in target) return target[property]
          return async () => {
            await new Promise((resolve) => setTimeout(resolve, 120))
            return settings
          }
        },
      },
    )
    Object.defineProperty(window, 'neoDeskPet', { configurable: true, value: api })
  })
}

const baselines = [
  { name: 'chat-default-720x620-scale100', route: 'chat', width: 720, height: 620, scale: 1, compactChat: true },
  { name: 'settings-default-860x680-scale100', route: 'settings', width: 860, height: 680, scale: 1, mockSettings: true, verifySettingsSearch: true, verifyConfirmDialog: true, verifyAiSplit: true },
  { name: 'memory-default-900x720-scale100', route: 'memory', width: 900, height: 720, scale: 1, mockMemory: true },
  { name: 'orb-panel-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbPanel: true },
  { name: 'chat-min-520x500-scale100', route: 'chat', width: 520, height: 500, scale: 1, compactChat: true, expandChat: true },
  { name: 'settings-min-640x500-scale100', route: 'settings', width: 640, height: 500, scale: 1, mockSettings: true, verifySettingsNavigation: true },
  { name: 'memory-min-640x500-scale100', route: 'memory', width: 640, height: 500, scale: 1, mockMemory: true },
  { name: 'chat-default-720x620-scale125', route: 'chat', width: 720, height: 620, scale: 1.25, compactChat: true },
  { name: 'settings-default-860x680-scale125', route: 'settings', width: 860, height: 680, scale: 1.25, mockSettings: true },
  { name: 'memory-default-900x720-scale125', route: 'memory', width: 900, height: 720, scale: 1.25, mockMemory: true },
  { name: 'chat-default-720x620-scale150', route: 'chat', width: 720, height: 620, scale: 1.5, compactChat: true },
  { name: 'settings-default-860x680-scale150', route: 'settings', width: 860, height: 680, scale: 1.5, mockSettings: true },
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
    if (baseline.mockSettings) await installSettingsMock(page)

    await page.goto(`${baseUrl}/#/${baseline.route}`, { waitUntil: 'networkidle' })
    await page.locator('#root > *').waitFor({ state: 'visible' })
    await page.waitForTimeout(350)

    const screenshotPath = path.join(outputDir, `${baseline.name}.png`)
    await page.screenshot({ path: screenshotPath })
    const metrics = await page.evaluate(() => {
      const settingsLayout = document.querySelector('.ndp-settings-layout')
      const settingsNav = document.querySelector('.ndp-settings-nav')
      const chatSummary = document.querySelector('.ndp-chat-membar-summary')
      const chatDetails = document.querySelector('.ndp-chat-membar-details')
      return {
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        body: { scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight },
        horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth,
        verticalOverflow: document.body.scrollHeight > document.documentElement.clientHeight,
        settingsNavigation: settingsLayout && settingsNav
          ? {
              layoutWidth: settingsLayout.clientWidth,
              layoutScrollWidth: settingsLayout.scrollWidth,
              navItems: settingsNav.querySelectorAll('.ndp-settings-nav-item').length,
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
    if (baseline.route === 'settings' && !metrics.settingsNavigation) {
      failures.push('settings left navigation is missing')
    }
    if (baseline.route === 'settings' && metrics.settingsNavigation?.layoutScrollWidth > metrics.settingsNavigation?.layoutWidth) {
      failures.push('settings layout has horizontal overflow')
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

    let settingsNavigation = null
    if (baseline.verifySettingsNavigation) {
      const navItems = page.locator('.ndp-settings-nav-item')
      const navCount = await navItems.count()
      const lastItem = navItems.last()
      await lastItem.scrollIntoViewIfNeeded()
      await lastItem.click()
      await page.waitForTimeout(100)
      const navigationEndScreenshotPath = path.join(outputDir, `${baseline.name}-navigation-end.png`)
      const navigationEndScreenshot = path.relative(projectRoot, navigationEndScreenshotPath)
      await page.screenshot({ path: navigationEndScreenshotPath })
      settingsNavigation = await page.evaluate(() => {
        const sidebar = document.querySelector('.ndp-settings-sidebar')
        const active = document.querySelector('.ndp-settings-nav-item.active')
        if (!sidebar || !active) return null
        const sidebarRect = sidebar.getBoundingClientRect()
        const activeRect = active.getBoundingClientRect()
        return {
          activeLabel: active.textContent?.trim() ?? '',
          activeVisible: activeRect.top >= sidebarRect.top - 1 && activeRect.bottom <= sidebarRect.bottom + 1,
          scrollTop: sidebar.scrollTop,
        }
      })
      if (settingsNavigation) settingsNavigation.screenshot = navigationEndScreenshot
      if (navCount < 2) failures.push('settings navigation has fewer than two entries')
      if (!settingsNavigation?.activeVisible) failures.push('last settings navigation item is not visible')
      if ((settingsNavigation?.scrollTop ?? 0) <= 0) failures.push('settings navigation did not scroll to the last entry')
    }

    let settingsSearch = null
    if (baseline.verifySettingsSearch) {
      const search = page.getByRole('searchbox', { name: '搜索设置' })
      await search.fill('endpoint')
      await search.press('Enter')
      await page.waitForTimeout(120)
      const baseUrlInput = page.locator('.ndp-setting-item').filter({ hasText: 'API Base URL' }).locator('input').first()
      await baseUrlInput.fill('https://settings-smoke.example/v1')
      const savingVisible = await page.getByRole('status').filter({ hasText: '保存中' }).isVisible().catch(() => false)
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined)
      const searchScreenshotPath = path.join(outputDir, `${baseline.name}-search.png`)
      const searchScreenshot = path.relative(projectRoot, searchScreenshotPath)
      await page.screenshot({ path: searchScreenshotPath })
      settingsSearch = await page.evaluate(() => ({
        activeLabel: document.querySelector('.ndp-settings-nav-item.active')?.textContent?.trim() ?? '',
        baseUrlVisible: Boolean(document.querySelector('.ndp-setting-search-hit')),
        saveState: document.querySelector('.ndp-settings-root')?.getAttribute('data-save-state') ?? '',
        contentClientHeight: document.querySelector('.ndp-settings-content')?.clientHeight ?? 0,
        contentScrollHeight: document.querySelector('.ndp-settings-content')?.scrollHeight ?? 0,
      }))
      settingsSearch.savingVisible = savingVisible
      settingsSearch.screenshot = searchScreenshot
      if (settingsSearch.activeLabel !== 'API 连接') failures.push(`settings search opened ${settingsSearch.activeLabel || 'nothing'}`)
      if (!settingsSearch.baseUrlVisible) failures.push('settings search did not highlight API Base URL')
      if (!settingsSearch.savingVisible) failures.push('settings save state did not show saving')
      if (settingsSearch.saveState !== 'saved') failures.push(`settings save state ended as ${settingsSearch.saveState}`)
      if (settingsSearch.contentScrollHeight > settingsSearch.contentClientHeight * 2) {
        failures.push(
          `API connection view exceeds two viewports: ${settingsSearch.contentScrollHeight}/${settingsSearch.contentClientHeight}`,
        )
      }

      await search.fill('向量')
      await search.press('Enter')
      await page.waitForTimeout(140)
      settingsSearch.deepSearch = await page.evaluate(() => ({
        activeLabel: document.querySelector('.ndp-settings-nav-item.active')?.textContent?.trim() ?? '',
        activeSubTab: document.querySelector('.ndp-settings-subtabs .ndp-tab-btn.active')?.textContent?.trim() ?? '',
        highlighted: Boolean(document.querySelector('.ndp-setting-search-hit')),
      }))
      if (settingsSearch.deepSearch.activeLabel !== '角色与长期记忆') {
        failures.push(`deep settings search opened ${settingsSearch.deepSearch.activeLabel || 'nothing'}`)
      }
      if (settingsSearch.deepSearch.activeSubTab !== '文本向量') {
        failures.push(`deep settings search opened subtab ${settingsSearch.deepSearch.activeSubTab || 'nothing'}`)
      }
      if (!settingsSearch.deepSearch.highlighted) failures.push('deep settings search did not highlight the vector section')
    }

    let settingsConfirmDialog = null
    if (baseline.verifyConfirmDialog) {
      await page.getByRole('button', { name: '设定库', exact: true }).click()
      await page.getByRole('button', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor({ state: 'visible' })
      const dialogScreenshotPath = path.join(outputDir, `${baseline.name}-confirm.png`)
      const dialogScreenshot = path.relative(projectRoot, dialogScreenshotPath)
      await page.screenshot({ path: dialogScreenshotPath })
      settingsConfirmDialog = {
        title: await dialog.getByRole('heading').textContent(),
        screenshot: dialogScreenshot,
      }
      await page.keyboard.press('Escape')
      const dismissed = await dialog.isHidden().catch(() => false)
      settingsConfirmDialog.dismissedWithEscape = dismissed
      if (settingsConfirmDialog.title?.trim() !== '删除设定') failures.push('settings confirmation dialog has the wrong title')
      if (!dismissed) failures.push('settings confirmation dialog did not close with Escape')
    }

    let aiSplit = null
    if (baseline.verifyAiSplit) {
      const expectedHeadings = [
        ['API 连接', 'API 连接'],
        ['模型与生成', '模型与生成'],
        ['视觉', '视觉路由'],
        ['Agent', 'Agent 设置'],
      ]
      const observed = []
      for (const [navLabel, heading] of expectedHeadings) {
        await page.getByRole('button', { name: navLabel, exact: true }).click()
        const headings = await page.locator('.ndp-settings-content h3').allTextContents()
        observed.push({ navLabel, headings })
        if (!headings.some((value) => value.trim() === heading)) {
          failures.push(`${navLabel} view is missing heading ${heading}`)
        }
      }
      await page.getByRole('button', { name: '模型与生成', exact: true }).click()
      const advanced = page.locator('.ndp-settings-advanced')
      const advancedClosed = (await advanced.count()) === 1 && !(await advanced.evaluate((element) => element.hasAttribute('open')))
      const aiSplitScreenshotPath = path.join(outputDir, `${baseline.name}-ai-generation.png`)
      const aiSplitScreenshot = path.relative(projectRoot, aiSplitScreenshotPath)
      await page.screenshot({ path: aiSplitScreenshotPath })
      aiSplit = { observed, advancedClosed, screenshot: aiSplitScreenshot }
      if (!advancedClosed) failures.push('AI advanced context settings are not collapsed by default')
    }

    report.items.push({
      ...baseline,
      screenshot: path.relative(projectRoot, screenshotPath),
      metrics,
      expandedChat,
      settingsNavigation,
      settingsSearch,
      settingsConfirmDialog,
      aiSplit,
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
