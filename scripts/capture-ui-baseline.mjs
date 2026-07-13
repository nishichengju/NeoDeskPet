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

function installChatMock(page, options = {}) {
  return page.addInitScript(({ seedImage, seedTool }) => {
    const now = Date.now()
    const settings = {
      activePersonaId: 'default',
      ai: {
        hasApiKey: false,
        apiMode: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        temperature: 0.7,
        maxTokens: 1200,
        enableChatStreaming: false,
      },
      memory: {
        enabled: true,
        autoExtractEnabled: true,
        autoExtractEveryEffectiveMessages: 20,
      },
      orchestrator: {
        plannerEnabled: false,
        plannerMode: 'auto',
        toolCallingEnabled: false,
        toolCallingMode: 'auto',
      },
      tts: { enabled: false, segmented: false },
      asr: { enabled: false, autoSend: false },
      chatUi: {},
      chatProfile: {},
      worldBook: { enabled: false, entries: [], activeTagIds: [], maxChars: 6000 },
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
    const initialTasks = seedTool
      ? [{
          id: 'baseline-tool-task',
          queue: 'chat',
          title: '工具卡基线任务',
          why: '验证工具卡渲染',
          status: 'done',
          createdAt: now,
          updatedAt: now,
          steps: [],
          currentStepIndex: 0,
          toolsUsed: ['web.search'],
          toolRuns: [{
            id: 'baseline-tool-run',
            toolName: 'web.search',
            status: 'done',
            inputPreview: '{"query":"NeoDeskPet"}',
            outputPreview: 'Found 3 results',
            startedAt: now,
            endedAt: now,
          }],
        }]
      : []
    const initialMessages = seedImage
      ? [{
          id: 'baseline-image-message',
          role: 'assistant',
          content: '图片查看器基线',
          image: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22640%22 height=%22360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%232e7d6b%22/%3E%3Ctext x=%22320%22 y=%22190%22 text-anchor=%22middle%22 font-size=%2240%22 fill=%22white%22%3ENeoDeskPet%3C/text%3E%3C/svg%3E',
          createdAt: now,
        }]
      : seedTool
        ? [{
            id: 'baseline-tool-message',
            role: 'assistant',
            content: '正在查询。\n\n查询完成。',
            blocks: [
              { type: 'text', text: '正在查询。' },
              { type: 'tool_use', taskId: 'baseline-tool-task', runId: 'baseline-tool-run' },
              { type: 'text', text: '查询完成。' },
            ],
            createdAt: now,
          }]
        : []
    const summary = {
      id: 'baseline-session',
      name: '界面基线会话',
      personaId: 'default',
      createdAt: now,
      updatedAt: now,
      messageCount: initialMessages.length,
    }
    const session = { ...summary, nameMode: 'manual', messages: initialMessages, autoExtractCursor: 0 }
    const calls = { settingsTargets: [], clearCount: 0, createCount: 0, renameCount: 0, cancelTaskIds: [], stopTtsCount: 0 }
    Object.defineProperty(window, '__chatBaseline', { configurable: true, value: calls })
    const off = () => undefined
    let tasksListener = null
    let activeTask = null
    calls.activateTask = () => {
      activeTask = {
        id: 'baseline-task',
        queue: 'chat',
        title: '界面测试任务',
        why: '验证统一停止行为',
        status: 'running',
        createdAt: now,
        updatedAt: now,
        steps: [],
        currentStepIndex: 0,
        toolsUsed: [],
      }
      session.messages.push({
        id: 'baseline-task-message',
        role: 'assistant',
        content: '工具任务运行中',
        createdAt: now,
        taskId: activeTask.id,
      })
      summary.messageCount = session.messages.length
      tasksListener?.({ items: [activeTask] })
    }
    const api = new Proxy(
      {
        getSettings: async () => settings,
        onSettingsChanged: () => off,
        listPersonas: async () => [{ id: persona.id, name: persona.name, updatedAt: now }],
        getPersona: async () => persona,
        listChatSessions: async () => ({ sessions: [summary], currentSessionId: summary.id }),
        getChatSession: async () => session,
        createChatSession: async () => {
          calls.createCount += 1
          return session
        },
        setCurrentChatSession: async () => summary,
        renameChatSession: async (sessionId, name) => {
          calls.renameCount += 1
          if (sessionId === summary.id) {
            summary.name = name
            session.name = name
          }
          return summary
        },
        clearChatSession: async () => {
          calls.clearCount += 1
          session.messages = []
          return session
        },
        addChatMessage: async (_sessionId, message) => {
          session.messages.push(message)
          summary.messageCount = session.messages.length
          return session
        },
        setChatMessages: async (_sessionId, messages) => {
          session.messages = messages
          summary.messageCount = messages.length
          return session
        },
        saveChatAttachmentFile: async (file, kind, filename) => ({
          ok: true,
          kind,
          path: `C:\\baseline\\${filename || file.name}`,
          resourceId: `baseline-${kind}-resource`,
          filename: filename || file.name,
          mimeType: file.type,
        }),
        listTasks: async () => ({ items: initialTasks }),
        onTasksChanged: (listener) => {
          tasksListener = listener
          return () => {
            if (tasksListener === listener) tasksListener = null
          }
        },
        cancelTask: async (taskId) => {
          calls.cancelTaskIds.push(taskId)
          if (activeTask?.id === taskId) {
            activeTask = { ...activeTask, status: 'canceled', updatedAt: Date.now() }
            tasksListener?.({ items: [activeTask] })
          }
          return activeTask
        },
        getMcpState: async () => ({ enabled: false, servers: [], updatedAt: now }),
        onMcpChanged: () => off,
        getContextUsage: async () => null,
        onContextUsageChanged: () => off,
        onAsrTranscript: () => off,
        onTtsSegmentStarted: () => off,
        onTtsUtteranceEnded: () => off,
        onTtsUtteranceFailed: () => off,
        openSettings: async (target) => {
          calls.settingsTargets.push(target ?? null)
        },
        openMemory: async () => undefined,
        closeCurrent: async () => undefined,
        setContextUsage: () => undefined,
        syncAsrComposePreview: () => undefined,
        notifyAsrTranscriptReady: () => undefined,
        takeAsrTranscript: async () => ({ text: '' }),
        stopTtsAll: () => {
          calls.stopTtsCount += 1
        },
        sendBubblePreview: () => undefined,
        sendBubbleMessage: () => undefined,
        appendDebugLog: () => undefined,
      },
      {
        get(target, property) {
          if (property in target) return target[property]
          if (typeof property === 'string' && property.startsWith('on')) return () => off
          return async () => settings
        },
      },
    )
    Object.defineProperty(window, 'neoDeskPet', { configurable: true, value: api })
  }, { seedImage: options.seedImage === true, seedTool: options.seedTool === true })
}

function installOrbMock(page, options) {
  return page.addInitScript(({ initialState, seedContent, seedHistory }) => {
    const now = Date.now()
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII='
    const secondImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1/8AAAAASUVORK5CYII='
    const task = {
      id: 'baseline-orb-task',
      queue: 'chat',
      title: 'Baseline tool',
      why: 'Verify Orb tool rendering',
      status: 'done',
      createdAt: now,
      updatedAt: now,
      steps: [],
      currentStepIndex: 0,
      toolsUsed: ['delay.sleep'],
      toolRuns: [
        {
          id: 'baseline-orb-run',
          toolName: 'delay.sleep',
          status: 'done',
          inputPreview: '{"ms":1}',
          outputPreview: 'sleep 1ms',
          imagePaths: [imageDataUrl, secondImageDataUrl],
          startedAt: now - 1000,
          endedAt: now,
        },
      ],
    }
    const messages = seedContent
      ? [
          { id: 'orb-user', role: 'user', content: 'Run the baseline tool.', createdAt: now - 2000 },
          {
            id: 'orb-assistant',
            role: 'assistant',
            content: 'Baseline result.',
            createdAt: now - 1000,
            blocks: [
              { type: 'text', text: '**Baseline result**' },
              { type: 'status', text: 'Tool completed' },
              { type: 'tool_use', taskId: task.id, runId: 'baseline-orb-run' },
            ],
            attachments: [{ kind: 'image', path: imageDataUrl, filename: 'baseline.png' }],
          },
        ]
      : []
    const summary = {
      id: 'baseline-session',
      name: '界面基线会话',
      personaId: 'default',
      createdAt: now,
      updatedAt: now,
      messageCount: messages.length,
    }
    const session = { ...summary, nameMode: 'manual', messages }
    const historySummary = {
      id: 'baseline-history-session',
      name: '较早的界面会话',
      personaId: 'default',
      createdAt: now - 10_000,
      updatedAt: now - 1_000,
      messageCount: 4,
    }
    const otherPersonaSummary = {
      id: 'baseline-other-persona',
      name: '其他角色会话',
      personaId: 'other',
      createdAt: now + 1_000,
      updatedAt: now + 1_000,
      messageCount: 99,
    }
    const historySession = { ...historySummary, nameMode: 'manual', messages: [] }
    const otherPersonaSession = { ...otherPersonaSummary, nameMode: 'manual', messages: [] }
    let summaries = seedHistory ? [otherPersonaSummary, historySummary, summary] : [summary]
    let currentSessionId = summary.id
    const sessionsById = new Map([
      [session.id, session],
      [historySession.id, historySession],
      [otherPersonaSession.id, otherPersonaSession],
    ])
    const baselineState = { selectedSessionIds: [], deletedSessionIds: [], openChatCount: 0 }
    Object.defineProperty(window, '__orbBaseline', { configurable: true, value: baselineState })
    const off = () => undefined
    const api = {
      getOrbUiState: async () => ({ state: initialState }),
      onOrbStateChanged: () => off,
      getSettings: async () => ({ activePersonaId: 'default' }),
      onSettingsChanged: () => off,
      listChatSessions: async () => ({ sessions: summaries, currentSessionId }),
      createChatSession: async () => session,
      setCurrentChatSession: async (sessionId) => {
        currentSessionId = sessionId
        baselineState.selectedSessionIds.push(sessionId)
        return summaries.find((item) => item.id === sessionId) ?? summary
      },
      getChatSession: async (sessionId) => sessionsById.get(sessionId ?? currentSessionId) ?? session,
      deleteChatSession: async (sessionId) => {
        baselineState.deletedSessionIds.push(sessionId)
        summaries = summaries.filter((item) => item.id !== sessionId)
        sessionsById.delete(sessionId)
        if (currentSessionId === sessionId) currentSessionId = summaries.find((item) => item.personaId === 'default')?.id ?? ''
        return { sessions: summaries, currentSessionId }
      },
      openChat: async () => {
        baselineState.openChatCount += 1
      },
      listTasks: async () => ({ items: seedContent ? [task] : [] }),
      onTasksChanged: () => off,
      setOrbUiState: async (state) => ({ state }),
      setOrbOverlayBounds: async () => ({ ok: true }),
      clearOrbOverlayBounds: async () => ({ ok: true }),
      getChatAttachmentUrl: async () => ({ ok: false, url: '' }),
      readChatAttachmentDataUrl: async () => ({ ok: false, dataUrl: '' }),
    }
    Object.defineProperty(window, 'neoDeskPet', { configurable: true, value: api })
  }, {
    initialState: options.state,
    seedContent: options.seedContent === true,
    seedHistory: options.seedHistory === true,
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
    let navigateListener = null
    Object.defineProperty(window, '__navigateSettings', {
      configurable: true,
      value: (target) => navigateListener?.(target),
    })
    const api = new Proxy(
      {
        getSettings: async () => settings,
        onSettingsChanged: () => off,
        onSettingsNavigate: (listener) => {
          navigateListener = listener
          return () => {
            if (navigateListener === listener) navigateListener = null
          }
        },
        consumeSettingsNavigation: async () => null,
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
  { name: 'pet-shell-300x500-scale100', route: 'pet', width: 300, height: 500, scale: 1 },
  { name: 'chat-default-720x620-scale100', route: 'chat', width: 720, height: 620, scale: 1, mockChat: true, compactChat: true },
  { name: 'settings-default-860x680-scale100', route: 'settings', width: 860, height: 680, scale: 1, mockSettings: true, verifySettingsSearch: true, verifyConfirmDialog: true, verifyAiSplit: true },
  { name: 'memory-default-900x720-scale100', route: 'memory', width: 900, height: 720, scale: 1, mockMemory: true },
  { name: 'orb-ball-80x80-scale100', route: 'orb', width: 80, height: 80, scale: 1, mockOrbState: 'ball' },
  { name: 'orb-bar-560x80-scale100', route: 'orb', width: 560, height: 80, scale: 1, mockOrbState: 'bar' },
  { name: 'orb-panel-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbState: 'panel' },
  { name: 'orb-panel-content-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbState: 'panel', seedOrbContent: true, verifyOrbContent: true },
  { name: 'orb-image-viewer-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbState: 'panel', seedOrbContent: true, verifyOrbContent: true, verifyOrbImageViewer: true },
  { name: 'orb-message-menu-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbState: 'panel', seedOrbContent: true, verifyOrbContent: true, verifyOrbMessageMenu: true },
  { name: 'orb-history-popover-560x720-scale100', route: 'orb', width: 560, height: 720, scale: 1, mockOrbState: 'panel', seedOrbHistory: true, verifyOrbHistory: true },
  { name: 'chat-compact-420x560-scale100', route: 'chat', width: 420, height: 560, scale: 1, mockChat: true, compactChat: true, expandChat: true, verifyChatUi: true },
  { name: 'chat-image-viewer-720x620-scale100', route: 'chat', width: 720, height: 620, scale: 1, mockChat: true, verifyImageViewer: true },
  { name: 'chat-tool-card-720x620-scale100', route: 'chat', width: 720, height: 620, scale: 1, mockChat: true, verifyToolCard: true },
  { name: 'settings-min-640x500-scale100', route: 'settings', width: 640, height: 500, scale: 1, mockSettings: true, verifySettingsNavigation: true },
  { name: 'memory-min-640x500-scale100', route: 'memory', width: 640, height: 500, scale: 1, mockMemory: true },
  { name: 'chat-default-720x620-scale125', route: 'chat', width: 720, height: 620, scale: 1.25, mockChat: true, compactChat: true },
  { name: 'settings-default-860x680-scale125', route: 'settings', width: 860, height: 680, scale: 1.25, mockSettings: true },
  { name: 'memory-default-900x720-scale125', route: 'memory', width: 900, height: 720, scale: 1.25, mockMemory: true },
  { name: 'chat-default-720x620-scale150', route: 'chat', width: 720, height: 620, scale: 1.5, mockChat: true, compactChat: true },
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
    if (baseline.mockChat) await installChatMock(page, {
      seedImage: baseline.verifyImageViewer,
      seedTool: baseline.verifyToolCard,
    })
    if (baseline.mockOrbState) await installOrbMock(page, {
      state: baseline.mockOrbState,
      seedContent: baseline.seedOrbContent,
      seedHistory: baseline.seedOrbHistory,
    })
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
      const chatSummary = document.querySelector('.ndp-chat-status-button')
      const chatDetails = document.querySelector('.ndp-chat-status-drawer')
      const rendererAssets = performance
        .getEntriesByType('resource')
        .map((entry) => {
          const url = new URL(entry.name)
          return {
            name: url.pathname.split('/').at(-1) ?? '',
            decodedBodySize: 'decodedBodySize' in entry ? entry.decodedBodySize : 0,
          }
        })
        .filter((entry) => /\.(?:css|js)$/.test(entry.name))
      return {
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        body: { scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight },
        horizontalOverflow: document.body.scrollWidth > document.documentElement.clientWidth,
        verticalOverflow: document.body.scrollHeight > document.documentElement.clientHeight,
        rendererAssets,
        orbContent: {
          messages: document.querySelectorAll('.ndp-orbpanel-msg').length,
          toolCards: document.querySelectorAll('.ndp-tooluse').length,
          attachments: document.querySelectorAll('.ndp-orbpanel-attachment').length,
        },
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
          : chatSummary
            ? { summaryVisible: getComputedStyle(chatSummary).display !== 'none', detailsVisible: false }
            : null,
      }
    })

    const failures = []
    if (metrics.horizontalOverflow) failures.push('body has horizontal overflow')
    const expectedRouteChunk = {
      pet: 'PetWindowEntry-',
      chat: 'ChatWindow-',
      settings: 'SettingsWindow-',
      memory: 'MemoryConsoleWindow-',
      orb: 'OrbApp-',
    }[baseline.route]
    const loadedAssetNames = metrics.rendererAssets.map((entry) => entry.name)
    if (expectedRouteChunk && !loadedAssetNames.some((name) => name.startsWith(expectedRouteChunk))) {
      failures.push(`${baseline.route} route chunk is missing from ${loadedAssetNames.join(',') || 'loaded assets'}`)
    }
    if (baseline.route === 'settings') {
      if (!loadedAssetNames.some((name) => name.startsWith('Live2DTab-'))) {
        failures.push('settings initial Live2D tab chunk is missing')
      }
      const eagerSettingsTabs = loadedAssetNames.filter((name) => /^(?:Ai|Persona|Tools|WorldBook)Tab-/.test(name))
      if (eagerSettingsTabs.length > 0) failures.push(`settings eagerly loaded ${eagerSettingsTabs.join(',')}`)
    }
    const live2dRuntimeNames = ['live2d.min.js', 'live2dcubismcore.min.js']
    if (baseline.route === 'pet') {
      const missingRuntimes = live2dRuntimeNames.filter((name) => !loadedAssetNames.includes(name))
      if (missingRuntimes.length > 0) failures.push(`pet route is missing ${missingRuntimes.join(',')}`)
    } else if (
      loadedAssetNames.some((name) => name.startsWith('PetWindowEntry-') || live2dRuntimeNames.includes(name))
    ) {
      failures.push(`${baseline.route} route loaded Pet/Live2D assets`)
    }
    const mainScript = metrics.rendererAssets.find((entry) => /^main-.+\.js$/.test(entry.name))
    if (!mainScript) failures.push('renderer main chunk metric is missing')
    else if (mainScript.decodedBodySize > 250_000) {
      failures.push(`renderer main chunk is ${mainScript.decodedBodySize} bytes`)
    }
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
    if (baseline.verifyOrbContent && metrics.orbContent.messages < 2) {
      failures.push(`orb content has only ${metrics.orbContent.messages} messages`)
    }
    if (baseline.verifyOrbContent && metrics.orbContent.toolCards < 1) {
      failures.push('orb content tool card is missing')
    }
    if (baseline.verifyOrbContent && metrics.orbContent.attachments < 2) {
      failures.push(`orb content has only ${metrics.orbContent.attachments} attachments`)
    }

    let expandedChat = null
    if (baseline.expandChat) {
      await page.locator('.ndp-chat-status-button').click()
      await page.waitForTimeout(100)
      const expandedScreenshotPath = path.join(outputDir, `${baseline.name}-expanded.png`)
      const expandedScreenshot = path.relative(projectRoot, expandedScreenshotPath)
      await page.screenshot({ path: expandedScreenshotPath })
      expandedChat = await page.evaluate(() => {
        const details = document.querySelector('.ndp-chat-status-drawer')
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
      if ((expandedChat?.detailsHeight ?? Number.POSITIVE_INFINITY) > 430) {
        failures.push(`compact chat status details are too tall: ${expandedChat?.detailsHeight}`)
      }
      if ((expandedChat?.messagesHeight ?? 0) < 100) {
        failures.push(`compact chat messages area is too short after expansion: ${expandedChat?.messagesHeight}`)
      }
      if (expandedChat?.horizontalOverflow) failures.push('expanded compact chat has horizontal overflow')
    }

    let chatUi = null
    if (baseline.verifyChatUi) {
      const statusDrawer = page.locator('.ndp-chat-status-drawer')
      const statusVisible = await statusDrawer.isVisible().catch(() => false)
      const quickSwitchCount = statusVisible ? await statusDrawer.locator('input[type="checkbox"]').count() : 0
      const statusMetricCount = statusVisible ? await statusDrawer.locator('dd').count() : 0
      if (!statusVisible) failures.push('chat runtime status drawer is not visible')
      if (quickSwitchCount < 5) failures.push(`chat runtime status drawer has only ${quickSwitchCount} quick switches`)
      if (statusMetricCount < 6) failures.push(`chat runtime status drawer has only ${statusMetricCount} metrics`)
      if (statusVisible) await statusDrawer.getByRole('button', { name: '关闭运行状态' }).click()

      const sessionButton = page.locator('.ndp-session-name')
      await sessionButton.click()
      const sessionList = page.locator('.ndp-session-list')
      await sessionList.waitFor({ state: 'visible' })
      const sessionItemCount = await sessionList.locator('.ndp-session-item').count()
      await sessionList.getByRole('button', { name: '重命名 界面基线会话' }).click()
      const sessionRenameInput = sessionList.locator('.ndp-session-rename-input')
      await sessionRenameInput.waitFor({ state: 'visible' })
      const sessionOriginalName = await sessionRenameInput.inputValue()
      await sessionRenameInput.fill('已重命名会话')
      const sessionScreenshotPath = path.join(outputDir, `${baseline.name}-session-rename.png`)
      const sessionScreenshot = path.relative(projectRoot, sessionScreenshotPath)
      await page.screenshot({ path: sessionScreenshotPath })
      await sessionRenameInput.press('Enter')
      await page.waitForFunction(() => window.__chatBaseline?.renameCount === 1)
      await sessionRenameInput.waitFor({ state: 'hidden' })
      const sessionSavedName = (await sessionButton.textContent())?.trim() ?? ''
      if (sessionItemCount !== 1) failures.push(`chat session list has ${sessionItemCount} items`)
      if (sessionOriginalName !== '界面基线会话') failures.push(`chat session rename opened with ${JSON.stringify(sessionOriginalName)}`)
      if (!sessionSavedName.includes('已重命名会话')) failures.push(`chat session rename saved ${sessionSavedName || 'nothing'}`)
      await sessionButton.click()
      await sessionList.waitFor({ state: 'hidden' })

      await page.getByRole('button', { name: '配置模型', exact: true }).click()
      await page.getByRole('button', { name: '选择角色', exact: true }).click()
      await page.getByRole('button', { name: '导入配置', exact: true }).click()
      const settingsTargets = await page.evaluate(() => window.__chatBaseline?.settingsTargets ?? [])
      if (settingsTargets.join(',') !== 'aiConnection,persona,tools') {
        failures.push(`chat empty-state settings targets are ${settingsTargets.join(',') || 'missing'}`)
      }

      await page.getByRole('button', { name: '添加附件' }).click()
      const attachmentMenu = page.getByRole('menu', { name: '添加附件' })
      const attachmentChoices = await attachmentMenu.getByRole('menuitem').allTextContents()
      if (attachmentChoices.map((value) => value.trim()).join(',') !== '图片,视频,图片或视频') {
        failures.push(`chat attachment menu choices are ${attachmentChoices.join(',') || 'missing'}`)
      }
      const fileChooserPromise = page.waitForEvent('filechooser')
      await attachmentMenu.getByRole('menuitem', { name: '图片', exact: true }).click()
      const fileChooser = await fileChooserPromise
      await fileChooser.setFiles({
        name: 'baseline.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1/8AAAAASUVORK5CYII=', 'base64'),
      })
      const attachmentPreview = page.locator('.ndp-input-preview')
      await attachmentPreview.waitFor({ state: 'visible' })
      const attachmentPreviewName = (await attachmentPreview.locator('.ndp-input-preview-meta').textContent())?.trim() ?? ''
      const attachmentPreviewScreenshotPath = path.join(outputDir, `${baseline.name}-attachment-preview.png`)
      const attachmentPreviewScreenshot = path.relative(projectRoot, attachmentPreviewScreenshotPath)
      await page.screenshot({ path: attachmentPreviewScreenshotPath })
      await attachmentPreview.getByRole('button', { name: '移除 baseline.png' }).click()
      await attachmentPreview.waitFor({ state: 'hidden' })
      if (attachmentPreviewName !== 'baseline.png') failures.push(`chat attachment preview is ${attachmentPreviewName || 'missing'}`)

      const composer = page.getByRole('textbox', { name: '消息输入' })
      await composer.fill('第一行')
      const singleLineHeight = await composer.evaluate((element) => element.getBoundingClientRect().height)
      await composer.press('Shift+Enter')
      await composer.type('第二行')
      const multilineValue = await composer.inputValue()
      const multilineHeight = await composer.evaluate((element) => element.getBoundingClientRect().height)
      if (multilineValue !== '第一行\n第二行') failures.push(`chat composer multiline value is ${JSON.stringify(multilineValue)}`)
      if (multilineHeight <= singleLineHeight) failures.push(`chat composer did not grow: ${singleLineHeight} -> ${multilineHeight}`)

      await composer.fill('输入法测试')
      await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
      const composingValue = await composer.inputValue()
      if (composingValue !== '输入法测试') failures.push('chat composer sent while composition was active')

      await page.evaluate(() => window.__chatBaseline?.activateTask?.())
      const stopButton = page.getByRole('button', { name: '停止当前输出' })
      await stopButton.waitFor({ state: 'visible' })
      await stopButton.click()
      await page.waitForFunction(() => window.__chatBaseline?.cancelTaskIds?.length === 1)
      await stopButton.waitFor({ state: 'hidden' })
      const stopState = await page.evaluate(() => ({
        canceled: window.__chatBaseline?.cancelTaskIds ?? [],
        stopTtsCount: window.__chatBaseline?.stopTtsCount ?? 0,
      }))
      if (stopState.canceled.join(',') !== 'baseline-task') failures.push('chat stop did not cancel the active tool task')
      if (stopState.stopTtsCount < 1) failures.push('chat stop did not stop TTS alongside the active task')

      await composer.fill('发送测试')
      await composer.press('Enter')
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息输入"]')?.value === '')
      await page.locator('.ndp-msg-row').first().waitFor({ state: 'visible' })
      await page.getByRole('button', { name: '发送' }).waitFor({ state: 'visible' })

      const userMessageRow = page.locator('.ndp-msg-row-user').last()
      await userMessageRow.click({ button: 'right' })
      const messageMenu = page.locator('.ndp-context-menu')
      await messageMenu.getByRole('button', { name: /编辑/ }).click()
      const inlineEditor = page.locator('.ndp-inline-textarea')
      await inlineEditor.waitFor({ state: 'visible' })
      const editOriginalValue = await inlineEditor.inputValue()
      const editScreenshotPath = path.join(outputDir, `${baseline.name}-message-edit.png`)
      const editScreenshot = path.relative(projectRoot, editScreenshotPath)
      await page.screenshot({ path: editScreenshotPath })
      await inlineEditor.fill('编辑后的消息')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.ndp-msg-row-user')?.textContent?.includes('编辑后的消息'))
      const editSavedText = (await userMessageRow.textContent())?.trim() ?? ''
      if (editOriginalValue !== '发送测试') failures.push(`chat inline editor opened with ${JSON.stringify(editOriginalValue)}`)
      if (!editSavedText.includes('编辑后的消息')) failures.push(`chat inline editor saved ${editSavedText || 'nothing'}`)

      await page.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '清空当前对话' }).click()
      const clearDialog = page.getByRole('dialog', { name: '清空当前对话' })
      await clearDialog.waitFor({ state: 'visible' })
      const clearDialogScreenshotPath = path.join(outputDir, `${baseline.name}-clear-confirm.png`)
      const clearDialogScreenshot = path.relative(projectRoot, clearDialogScreenshotPath)
      await page.screenshot({ path: clearDialogScreenshotPath })
      await page.keyboard.press('Escape')
      if (!(await clearDialog.isHidden().catch(() => false))) failures.push('chat clear confirmation did not close with Escape')

      await page.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '清空当前对话' }).click()
      await clearDialog.getByRole('button', { name: '清空对话', exact: true }).click()
      await page.waitForFunction(() => window.__chatBaseline?.clearCount === 1)
      const clearCount = await page.evaluate(() => window.__chatBaseline?.clearCount ?? 0)
      if (clearCount !== 1) failures.push(`chat clear action ran ${clearCount} times`)

      chatUi = {
        statusVisible,
        quickSwitchCount,
        statusMetricCount,
        sessionState: {
          itemCount: sessionItemCount,
          originalName: sessionOriginalName,
          savedName: sessionSavedName,
          renameCount: 1,
          screenshot: sessionScreenshot,
        },
        settingsTargets,
        attachmentChoices,
        attachmentPreviewName,
        attachmentPreviewScreenshot,
        multilineValue,
        singleLineHeight,
        multilineHeight,
        composingValue,
        stopState,
        editState: { originalValue: editOriginalValue, savedText: editSavedText, screenshot: editScreenshot },
        clearCount,
        clearDialogScreenshot,
      }
    }

    let imageViewer = null
    if (baseline.verifyImageViewer) {
      const messageImage = page.locator('.ndp-msg-image').first()
      await messageImage.waitFor({ state: 'visible' })
      await messageImage.click()
      const viewer = page.locator('.ndp-image-viewer')
      await viewer.waitFor({ state: 'visible' })
      imageViewer = await viewer.evaluate((element) => ({
        meta: element.querySelector('.ndp-image-viewer-meta')?.textContent?.trim() ?? '',
        title: element.querySelector('.ndp-image-viewer-title')?.textContent?.trim() ?? '',
        horizontalOverflow: element.scrollWidth > element.clientWidth,
      }))
      const viewerScreenshotPath = path.join(outputDir, `${baseline.name}-open.png`)
      imageViewer.screenshot = path.relative(projectRoot, viewerScreenshotPath)
      await page.screenshot({ path: viewerScreenshotPath })
      if (!imageViewer.meta.includes('1 / 1') || !imageViewer.meta.includes('100%')) {
        failures.push(`image viewer meta is ${imageViewer.meta || 'missing'}`)
      }
      if (!imageViewer.title) failures.push('image viewer title is missing')
      if (imageViewer.horizontalOverflow) failures.push('image viewer has horizontal overflow')
      await page.keyboard.press('Escape')
      if (!(await viewer.isHidden().catch(() => false))) failures.push('image viewer did not close with Escape')
    }

    let orbImageViewer = null
    if (baseline.verifyOrbImageViewer) {
      const attachment = page.locator('.ndp-orbpanel-attachment').first()
      await attachment.waitFor({ state: 'visible' })
      await attachment.click()
      const viewer = page.locator('.ndp-orbimg-viewer')
      await viewer.waitFor({ state: 'visible' })
      const readViewerState = () => viewer.evaluate((element) => {
        const image = element.querySelector('.ndp-orbimg-viewer-img')
        return {
          meta: element.querySelector('.ndp-orbimg-viewer-meta')?.textContent?.trim() ?? '',
          title: element.querySelector('.ndp-orbimg-viewer-title')?.textContent?.trim() ?? '',
          navCount: element.querySelectorAll('.ndp-orbimg-viewer-nav').length,
          transform: image?.style?.transform ?? '',
          horizontalOverflow: element.scrollWidth > element.clientWidth,
        }
      })
      const initial = await readViewerState()
      await page.keyboard.press('d')
      await page.waitForFunction(() => document.querySelector('.ndp-orbimg-viewer-meta')?.textContent?.trim() === '2/2')
      const afterNext = await readViewerState()
      await viewer.locator('.ndp-orbimg-viewer-stage').dispatchEvent('wheel', { deltaY: -100 })
      await page.waitForFunction(() => {
        const transform = document.querySelector('.ndp-orbimg-viewer-img')?.style?.transform ?? ''
        return transform !== 'scale(1)'
      })
      const afterZoom = await readViewerState()
      await viewer.getByRole('button', { name: '1:1' }).click()
      const afterReset = await readViewerState()
      const viewerScreenshotPath = path.join(outputDir, `${baseline.name}-open.png`)
      await page.screenshot({ path: viewerScreenshotPath })
      orbImageViewer = {
        initial,
        afterNext,
        afterZoom,
        afterReset,
        screenshot: path.relative(projectRoot, viewerScreenshotPath),
      }
      if (initial.meta !== '1/2') failures.push(`orb image viewer initial meta is ${initial.meta || 'missing'}`)
      if (initial.navCount !== 2) failures.push(`orb image viewer has ${initial.navCount} navigation buttons`)
      if (afterNext.meta !== '2/2') failures.push(`orb image viewer next meta is ${afterNext.meta || 'missing'}`)
      if (!afterNext.title) failures.push('orb image viewer title is missing')
      if (afterZoom.transform === 'scale(1)') failures.push('orb image viewer did not zoom with the wheel')
      if (afterReset.transform !== 'scale(1)') failures.push(`orb image viewer reset transform is ${afterReset.transform || 'missing'}`)
      if (initial.horizontalOverflow || afterNext.horizontalOverflow) failures.push('orb image viewer has horizontal overflow')
      await page.keyboard.press('Escape')
      if (!(await viewer.isHidden().catch(() => false))) failures.push('orb image viewer did not close with Escape')
    }

    let orbMessageMenu = null
    if (baseline.verifyOrbMessageMenu) {
      const assistantMessage = page.locator('.ndp-orbpanel-msg-assistant').first()
      await assistantMessage.waitFor({ state: 'visible' })
      await assistantMessage.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: Math.max(1, Math.min(window.innerWidth - 2, rect.right - 2)),
          clientY: Math.max(1, Math.min(window.innerHeight - 2, rect.bottom - 2)),
        }))
      })
      const menu = page.locator('.ndp-orbapp-msgmenu')
      await menu.waitFor({ state: 'visible' })
      const assistantItems = (await menu.locator('.ndp-orbapp-msgmenu-item').allTextContents()).map((text) => text.trim())
      const assistantGeometry = await page.evaluate(() => {
        const root = document.querySelector('.ndp-orbapp-root')?.getBoundingClientRect()
        const menuRect = document.querySelector('.ndp-orbapp-msgmenu')?.getBoundingClientRect()
        if (!root || !menuRect) return null
        return {
          left: menuRect.left - root.left,
          top: menuRect.top - root.top,
          right: menuRect.right - root.left,
          bottom: menuRect.bottom - root.top,
          rootWidth: root.width,
          rootHeight: root.height,
          inlineStyle: document.querySelector('.ndp-orbapp-msgmenu')?.getAttribute('style') ?? '',
        }
      })
      const menuScreenshotPath = path.join(outputDir, `${baseline.name}-assistant.png`)
      await page.screenshot({ path: menuScreenshotPath })
      await menu.getByRole('button', { name: '编辑', exact: true }).click()
      const editor = page.locator('.ndp-orbpanel-edit-textarea')
      await editor.waitFor({ state: 'visible' })
      const assistantEditValue = await editor.inputValue()
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })

      const userMessage = page.locator('.ndp-orbpanel-msg-user').first()
      await userMessage.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: Math.max(1, rect.left + rect.width / 2),
          clientY: Math.max(1, rect.top + rect.height / 2),
        }))
      })
      await menu.waitFor({ state: 'visible' })
      const userItems = (await menu.locator('.ndp-orbapp-msgmenu-item').allTextContents()).map((text) => text.trim())
      await page.locator('.ndp-orbapp-input').click()
      const closedOutside = await menu.isHidden().catch(() => false)

      orbMessageMenu = {
        assistantItems,
        assistantGeometry,
        assistantEditValue,
        userItems,
        closedOutside,
        screenshot: path.relative(projectRoot, menuScreenshotPath),
      }
      if (assistantItems.join(',') !== '复制正文,编辑,重新生成,删除此条,删除本轮') {
        failures.push(`orb assistant message menu items are ${assistantItems.join(',') || 'missing'}`)
      }
      if (!assistantGeometry) {
        failures.push('orb assistant message menu geometry is missing')
      } else if (
        assistantGeometry.left < 0 ||
        assistantGeometry.top < 0 ||
        assistantGeometry.right > assistantGeometry.rootWidth ||
        assistantGeometry.bottom > assistantGeometry.rootHeight
      ) {
        failures.push(`orb assistant message menu exceeds root bounds: ${JSON.stringify(assistantGeometry)}`)
      }
      if (!assistantGeometry?.inlineStyle.includes('left:') || !assistantGeometry.inlineStyle.includes('top:')) {
        failures.push(`orb assistant message menu position style is ${assistantGeometry?.inlineStyle || 'missing'}`)
      }
      if (!assistantEditValue.includes('Baseline result')) failures.push('orb assistant edit did not load the message text')
      if (userItems.join(',') !== '编辑,重新生成,删除此条,删除本轮') {
        failures.push(`orb user message menu items are ${userItems.join(',') || 'missing'}`)
      }
      if (!closedOutside) failures.push('orb message menu did not close after an outside click')
    }

    let orbHistory = null
    if (baseline.verifyOrbHistory) {
      const historyButton = page.locator('[title="历史对话"]')
      await historyButton.click()
      const popover = page.locator('.ndp-orbapp-popover')
      await popover.waitFor({ state: 'visible' })
      const sessionButtons = popover.locator('.ndp-orbapp-popover-item-main')
      const sessionTitles = await sessionButtons.evaluateAll((elements) => elements.map((element) => element.getAttribute('title') ?? ''))
      const sessionCounts = (await popover.locator('.ndp-orbapp-popover-count').allTextContents()).map((text) => text.trim())
      const geometry = await page.evaluate(() => {
        const root = document.querySelector('.ndp-orbapp-root')?.getBoundingClientRect()
        const popoverElement = document.querySelector('.ndp-orbapp-popover')
        const popoverRect = popoverElement?.getBoundingClientRect()
        if (!root || !popoverRect) return null
        return {
          left: popoverRect.left - root.left,
          top: popoverRect.top - root.top,
          right: popoverRect.right - root.left,
          bottom: popoverRect.bottom - root.top,
          rootWidth: root.width,
          rootHeight: root.height,
          inlineStyle: popoverElement?.getAttribute('style') ?? '',
        }
      })
      const historyScreenshotPath = path.join(outputDir, `${baseline.name}-open.png`)
      await page.screenshot({ path: historyScreenshotPath })

      await sessionButtons.filter({ hasText: '较早的界面会话' }).click()
      await popover.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => window.__orbBaseline?.selectedSessionIds?.includes('baseline-history-session'))

      await historyButton.click()
      await popover.waitFor({ state: 'visible' })
      const historyRow = popover.locator('.ndp-orbapp-popover-row').filter({ hasText: '较早的界面会话' })
      await historyRow.getByRole('button', { name: '删除该会话' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.ndp-orbapp-popover-item-main').length === 1)
      const remainingTitles = await popover.locator('.ndp-orbapp-popover-item-main').evaluateAll(
        (elements) => elements.map((element) => element.getAttribute('title') ?? ''),
      )
      await popover.getByRole('button', { name: '查看全部历史对话' }).click()
      await page.waitForFunction(() => window.__orbBaseline?.openChatCount === 1)
      const actionState = await page.evaluate(() => ({
        selectedSessionIds: window.__orbBaseline?.selectedSessionIds ?? [],
        deletedSessionIds: window.__orbBaseline?.deletedSessionIds ?? [],
        openChatCount: window.__orbBaseline?.openChatCount ?? 0,
      }))

      orbHistory = {
        sessionTitles,
        sessionCounts,
        geometry,
        remainingTitles,
        actionState,
        screenshot: path.relative(projectRoot, historyScreenshotPath),
      }
      if (sessionTitles.join(',') !== '界面基线会话,较早的界面会话') {
        failures.push(`orb history sessions are ${sessionTitles.join(',') || 'missing'}`)
      }
      if (sessionCounts.join(',') !== '空,4') failures.push(`orb history counts are ${sessionCounts.join(',') || 'missing'}`)
      if (!geometry) {
        failures.push('orb history popover geometry is missing')
      } else if (
        geometry.left < 0 ||
        geometry.top < 0 ||
        geometry.right > geometry.rootWidth ||
        geometry.bottom > geometry.rootHeight
      ) {
        failures.push(`orb history popover exceeds root bounds: ${JSON.stringify(geometry)}`)
      }
      if (!geometry?.inlineStyle.includes('--ndp-orbapp-popover-arrow-x')) {
        failures.push(`orb history arrow style is ${geometry?.inlineStyle || 'missing'}`)
      }
      if (remainingTitles.join(',') !== '界面基线会话') {
        failures.push(`orb history remaining sessions are ${remainingTitles.join(',') || 'missing'}`)
      }
      if (!actionState.selectedSessionIds.includes('baseline-history-session')) failures.push('orb history selection was not delegated')
      if (!actionState.deletedSessionIds.includes('baseline-history-session')) failures.push('orb history deletion was not delegated')
      if (actionState.openChatCount !== 1) failures.push(`orb history open-all ran ${actionState.openChatCount} times`)
    }

    let toolCard = null
    if (baseline.verifyToolCard) {
      const summary = page.locator('.ndp-tooluse-summary').first()
      await summary.waitFor({ state: 'visible' })
      const summaryText = (await summary.textContent())?.trim() ?? ''
      if (!summaryText.includes('DeskPet · ToolUse: web.search')) failures.push(`tool card summary is ${summaryText || 'missing'}`)
      await summary.click()
      const body = page.locator('.ndp-tooluse-body').first()
      await body.waitFor({ state: 'visible' })
      toolCard = await body.evaluate((element) => ({
        text: element.textContent?.trim() ?? '',
        horizontalOverflow: element.scrollWidth > element.clientWidth,
      }))
      const toolCardScreenshotPath = path.join(outputDir, `${baseline.name}-open.png`)
      toolCard.screenshot = path.relative(projectRoot, toolCardScreenshotPath)
      await page.screenshot({ path: toolCardScreenshotPath })
      if (!toolCard.text.includes('in: {"query":"NeoDeskPet"}')) failures.push('tool card input preview is missing')
      if (!toolCard.text.includes('out: Found 3 results')) failures.push('tool card output preview is missing')
      if (toolCard.horizontalOverflow) failures.push('tool card has horizontal overflow')
    }

    let settingsNavigation = null
    if (baseline.verifySettingsNavigation) {
      const navItems = page.locator('.ndp-settings-nav-item')
      const navCount = await navItems.count()
      const lastItem = navItems.last()
      await lastItem.scrollIntoViewIfNeeded()
      await lastItem.click()
      await page.locator('.ndp-settings-content .ndp-setting-item').first().waitFor({ state: 'visible' })
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
      await page.evaluate(() => window.__navigateSettings?.('aiConnection'))
      await page.getByRole('heading', { name: 'API 连接', exact: true }).waitFor({ state: 'visible' })
      const directNavigationLabel = await page.locator('.ndp-settings-nav-item.active').textContent()
      if (directNavigationLabel?.trim() !== 'API 连接') {
        failures.push(`settings direct navigation opened ${directNavigationLabel?.trim() || 'nothing'}`)
      }
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
      settingsSearch.directNavigationLabel = directNavigationLabel?.trim() ?? ''
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
      await page.waitForFunction(() => {
        const activeSubTab = document.querySelector('.ndp-settings-subtabs .ndp-tab-btn.active')?.textContent?.trim() ?? ''
        return activeSubTab === '文本向量' && Boolean(document.querySelector('.ndp-setting-search-hit'))
      }, { timeout: 2_000 }).catch(() => undefined)
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
        await page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'visible' })
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

    let settingsLazyAssets = null
    if (baseline.verifyAiSplit) {
      settingsLazyAssets = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname.split('/').at(-1) ?? '')
          .filter((name) => /^(?:Ai|Persona|WorldBook)Tab-/.test(name)),
      )
      for (const expected of ['AiTab-', 'PersonaTab-', 'WorldBookTab-']) {
        if (!settingsLazyAssets.some((name) => name.startsWith(expected))) {
          failures.push(`settings did not lazy load ${expected}`)
        }
      }
    }

    if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`)

    report.items.push({
      ...baseline,
      screenshot: path.relative(projectRoot, screenshotPath),
      metrics,
      expandedChat,
      chatUi,
      imageViewer,
      orbImageViewer,
      orbMessageMenu,
      orbHistory,
      toolCard,
      settingsNavigation,
      settingsSearch,
      settingsConfirmDialog,
      aiSplit,
      settingsLazyAssets,
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
