import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const outputDir = path.join(projectRoot, 'artifacts', `ipc-security-smoke-${stamp}`)
const userDataDir = path.join(outputDir, 'userData')
const settingsFile = path.join(userDataDir, 'neodeskpet-settings.json')
const secretsFile = path.join(userDataDir, 'neodeskpet-secrets.json')
const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const packagedDir = path.join(projectRoot, 'release', packageVersion, 'win-unpacked')
const packagedExeName = existsSync(packagedDir)
  ? readdirSync(packagedDir).find((name) => name.toLowerCase().endsWith('.exe'))
  : undefined
const packagedExe = packagedExeName ? path.join(packagedDir, packagedExeName) : ''
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

mkdirSync(userDataDir, { recursive: true })

const aiSmokeKey = 'ipc-smoke-main-key'
const aiRequests = []
const aiServer = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const body = bodyText ? JSON.parse(bodyText) : {}
  aiRequests.push({
    path: request.url,
    authMatches: request.headers.authorization === `Bearer ${aiSmokeKey}`,
    streaming: body.stream === true,
  })

  if (body.stream === true) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"代理"}}]}\n\n')
    response.end('data: [DONE]\n\n')
    return
  }

  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ ok: true, via: 'main-process' }))
})
await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve))
const aiServerAddress = aiServer.address()
const aiServerOrigin = `http://127.0.0.1:${aiServerAddress.port}`
const expectedWindowSizes = {
  chat: { defaultWidth: 720, defaultHeight: 620, minWidth: 420, minHeight: 500 },
  settings: { defaultWidth: 860, defaultHeight: 680, minWidth: 640, minHeight: 500 },
  memory: { defaultWidth: 900, defaultHeight: 720, minWidth: 640, minHeight: 500 },
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForApi(page, route) {
  await page.waitForFunction(
    (expectedRoute) => window.location.hash === `#/${expectedRoute}` && Boolean(window.neoDeskPet?.getSettings),
    route,
    { timeout: 30_000 },
  )
}

async function waitForMainWindowApi(page) {
  return page.waitForFunction(
    () => {
      const route = window.location.hash.replace(/^#\//, '')
      return (route === 'pet' || route === 'orb') && Boolean(window.neoDeskPet?.getSettings)
        ? route
        : false
    },
    undefined,
    { timeout: 30_000 },
  )
}

async function openWindow(app, sourcePage, method, route, argument) {
  const existing = app.windows().find((page) => page.url().endsWith(`#/${route}`))
  if (existing) {
    await waitForApi(existing, route)
    return existing
  }

  const windowPromise = app.waitForEvent('window', { timeout: 30_000 })
  await sourcePage.evaluate(
    ({ methodName, value }) => window.neoDeskPet[methodName](value),
    { methodName: method, value: argument },
  )
  const page = await windowPromise
  await waitForApi(page, route)
  return page
}

async function apiKeys(page) {
  return page.evaluate(() => Object.keys(window.neoDeskPet).sort())
}

async function windowSize(page) {
  return page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }))
}

const executablePath = packagedExe && existsSync(packagedExe) ? packagedExe : electronExe
const args = packagedExe && existsSync(packagedExe)
  ? [`--user-data-dir=${userDataDir}`]
  : [projectRoot, `--user-data-dir=${userDataDir}`]

async function launchApp() {
  return electron.launch({ executablePath, args, timeout: 30_000 })
}

let app
try {
  app = await launchApp()
  const pet = await app.firstWindow({ timeout: 30_000 })
  await waitForApi(pet, 'pet')

  const chat = await openWindow(app, pet, 'openChat', 'chat')
  const settings = await openWindow(app, chat, 'openSettings', 'settings', 'aiConnection')
  const memory = await openWindow(app, settings, 'openMemory', 'memory')
  let orb = app.windows().find((page) => page.url().endsWith('#/orb'))
  if (!orb) {
    const windowPromise = app.waitForEvent('window', { timeout: 30_000 })
    await pet.evaluate(() => window.neoDeskPet.setDisplayMode('orb'))
    orb = await windowPromise
  }
  await waitForApi(orb, 'orb')

  const defaultWindowSizes = {
    chat: await windowSize(chat),
    settings: await windowSize(settings),
    memory: await windowSize(memory),
  }
  for (const type of Object.keys(defaultWindowSizes)) {
    const actual = defaultWindowSizes[type]
    const expected = expectedWindowSizes[type]
    assert(
      Math.abs(actual.width - expected.defaultWidth) <= 4 && Math.abs(actual.height - expected.defaultHeight) <= 4,
      `${type} default size is ${actual.width}x${actual.height}, expected ${expected.defaultWidth}x${expected.defaultHeight}`,
    )
  }

  await settings.locator('.ndp-settings-nav-item.active').filter({ hasText: 'API 连接' }).waitFor({ state: 'visible' })
  const settingsNavigationOnCreate = await settings.locator('.ndp-settings-nav-item.active').textContent()
  assert(settingsNavigationOnCreate?.trim() === 'API 连接', 'chat could not deep-link while creating the settings window')
  await chat.evaluate(() => window.neoDeskPet.openSettings('persona'))
  await settings.locator('.ndp-settings-nav-item.active').filter({ hasText: '角色与长期记忆' }).waitFor({ state: 'visible' })
  const settingsNavigationOnReuse = await settings.locator('.ndp-settings-nav-item.active').textContent()
  assert(settingsNavigationOnReuse?.trim() === '角色与长期记忆', 'chat could not deep-link an existing settings window')

  await settings.evaluate(
    async ({ origin, key }) => {
      await window.neoDeskPet.setSecret('ai-main', key)
      await window.neoDeskPet.setAISettings({ baseUrl: `${origin}/v1`, model: 'ipc-smoke' })
    },
    { origin: aiServerOrigin, key: aiSmokeKey },
  )
  const rendererSecretExposure = await Promise.all(
    [pet, chat, settings, memory, orb].map((page) =>
      page.evaluate(async () => {
        const current = await window.neoDeskPet.getSettings()
        return { apiKey: current.ai.apiKey, hasApiKey: current.ai.hasApiKey }
      }),
    ),
  )
  assert(
    rendererSecretExposure.every((item) => item.apiKey === '' && item.hasApiKey === true),
    'renderer settings exposed the AI API key',
  )
  const aiProxyRequest = await chat.evaluate(async () => {
    const response = await window.neoDeskPet.aiHttpRequest({
      credential: { kind: 'main' },
      body: { model: 'ipc-smoke', messages: [] },
    })
    return { ok: response.ok, status: response.status, body: JSON.parse(response.bodyText) }
  })
  const aiProxyStream = await chat.evaluate(async () => {
    const streamId = `ipc_smoke_${Date.now().toString(36)}`
    const decoder = new TextDecoder()
    let text = ''
    return await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('AI proxy stream timed out'))
      }, 10_000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        offChunk()
        offDone()
        offError()
      }
      const offChunk = window.neoDeskPet.onAiHttpStreamChunk((payload) => {
        if (payload.streamId === streamId) text += decoder.decode(payload.chunk, { stream: true })
      })
      const offDone = window.neoDeskPet.onAiHttpStreamDone((payload) => {
        if (payload.streamId !== streamId) return
        cleanup()
        resolve({ ok: true, text })
      })
      const offError = window.neoDeskPet.onAiHttpStreamError((payload) => {
        if (payload.streamId !== streamId) return
        cleanup()
        reject(new Error(payload.error))
      })
      void window.neoDeskPet
        .aiHttpStreamStart({
          streamId,
          credential: { kind: 'main' },
          body: { model: 'ipc-smoke', stream: true, messages: [] },
        })
        .then((result) => {
          if (!result.ok) throw new Error(`AI proxy stream HTTP ${result.status}`)
        })
        .catch((error) => {
          cleanup()
          reject(error)
        })
    })
  })
  assert(aiProxyRequest.ok && aiProxyRequest.body?.via === 'main-process', 'AI proxy request failed')
  assert(aiProxyStream.ok && aiProxyStream.text.includes('代理'), 'AI proxy stream failed')
  assert(aiRequests.length === 2 && aiRequests.every((request) => request.authMatches), 'AI proxy did not inject the configured key')
  assert(aiRequests.every((request) => request.path === '/v1/chat/completions'), 'AI proxy used an unexpected endpoint')

  const keys = {
    pet: await apiKeys(pet),
    chat: await apiKeys(chat),
    settings: await apiKeys(settings),
    memory: await apiKeys(memory),
    orb: await apiKeys(orb),
  }

  const runtimeErrors = {}
  for (const [route, page] of Object.entries({ pet, chat, settings, memory, orb })) {
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApi(page, route)
    await page.waitForTimeout(250)
    runtimeErrors[route] = errors
    assert(errors.length === 0, `${route} emitted runtime errors: ${errors.join(' | ')}`)
  }

  assert(keys.pet.includes('quit'), 'pet is missing its quit capability')
  assert(!keys.pet.includes('setAISettings'), 'pet exposes settings mutation')
  assert(!keys.pet.includes('getChatAttachmentUrl'), 'pet exposes local media access')
  assert(keys.chat.includes('getChatAttachmentUrl'), 'chat is missing local media access')
  assert(!keys.chat.includes('setAISettings'), 'chat exposes AI settings mutation')
  assert(!keys.chat.includes('quit'), 'chat exposes app quit')
  assert(keys.settings.includes('setAISettings'), 'settings is missing AI settings mutation')
  assert(!keys.settings.includes('getChatAttachmentUrl'), 'settings exposes local media access')
  assert(!keys.settings.includes('deleteManyMemory'), 'settings exposes bulk memory deletion')
  assert(keys.memory.includes('deleteManyMemory'), 'memory is missing bulk memory deletion')
  assert(!keys.memory.includes('setAISettings'), 'memory exposes AI settings mutation')
  assert(keys.orb.includes('getChatAttachmentUrl'), 'orb is missing local media access')
  assert(keys.orb.includes('quit'), 'orb is missing app quit')
  assert(!keys.orb.includes('setAISettings'), 'orb exposes AI settings mutation')

  const routeTamper = await chat.evaluate(async () => {
    window.location.hash = '#/settings'
    await new Promise((resolve) => setTimeout(resolve, 50))
    let denied = false
    let error = ''
    try {
      await window.neoDeskPet.getSettings()
    } catch (caught) {
      denied = true
      error = caught instanceof Error ? caught.message : String(caught)
    }
    window.location.hash = '#/chat'
    await new Promise((resolve) => setTimeout(resolve, 50))
    const recovered = Boolean(await window.neoDeskPet.getSettings())
    return { denied, error, recovered }
  })
  assert(routeTamper.denied, 'route-tampered renderer retained IPC access')
  assert(routeTamper.recovered, 'chat IPC did not recover after restoring the trusted route')

  const childWindowDenied = await chat.evaluate(() => {
    const child = window.open('file:///C:/Windows/System32/notepad.exe')
    return child == null || child.closed
  })
  assert(childWindowDenied, 'renderer opened an Electron child window')

  await chat.evaluate(() => {
    window.location.href = 'file:///C:/Windows/System32/notepad.exe'
  })
  await chat.waitForTimeout(150)
  assert(chat.url().endsWith('#/chat'), `untrusted navigation was not blocked: ${chat.url()}`)

  const urls = {
    pet: pet.url(),
    chat: chat.url(),
    settings: settings.url(),
    memory: memory.url(),
    orb: orb.url(),
  }

  await app.close()
  app = undefined

  assert(existsSync(settingsFile), 'settings file was not created')
  assert(existsSync(secretsFile), 'encrypted secrets file was not created')
  const settingsText = readFileSync(settingsFile, 'utf8')
  const secretsText = readFileSync(secretsFile, 'utf8')
  assert(!settingsText.includes(aiSmokeKey), 'settings file contains the plaintext AI key')
  assert(!secretsText.includes(aiSmokeKey), 'encrypted secrets file contains the plaintext AI key')
  const persistedSettings = JSON.parse(settingsText)
  const persistedSecrets = JSON.parse(secretsText)
  assert(persistedSettings?.ai?.apiKey === '', 'settings file retained a usable AI key')
  assert(
    typeof persistedSecrets?.values?.['ai.main'] === 'string' && persistedSecrets.values['ai.main'].length > 0,
    'encrypted secrets file is missing the main AI key',
  )

  persistedSettings.chatWindowBounds = { ...(persistedSettings.chatWindowBounds ?? {}), width: 420, height: 360 }
  persistedSettings.settingsWindowBounds = { ...(persistedSettings.settingsWindowBounds ?? {}), width: 420, height: 400 }
  persistedSettings.memoryWindowBounds = { ...(persistedSettings.memoryWindowBounds ?? {}), width: 560, height: 480 }
  writeFileSync(settingsFile, `${JSON.stringify(persistedSettings, null, 2)}\n`, 'utf8')

  app = await launchApp()
  const restartedPet = await app.firstWindow({ timeout: 30_000 })
  const restartMainRoute = await (await waitForMainWindowApi(restartedPet)).jsonValue()
  const restartedChat = await openWindow(app, restartedPet, 'openChat', 'chat')
  const restartedSettings = await openWindow(app, restartedChat, 'openSettings', 'settings')
  const restartedMemory = await openWindow(app, restartedSettings, 'openMemory', 'memory')
  const normalizedLegacyWindowSizes = {
    chat: await windowSize(restartedChat),
    settings: await windowSize(restartedSettings),
    memory: await windowSize(restartedMemory),
  }
  for (const type of Object.keys(normalizedLegacyWindowSizes)) {
    const actual = normalizedLegacyWindowSizes[type]
    const expected = expectedWindowSizes[type]
    assert(
      actual.width >= expected.minWidth && actual.height >= expected.minHeight,
      `${type} legacy size was not normalized after restart: ${actual.width}x${actual.height}`,
    )
  }
  const restartSecretExposure = await restartedChat.evaluate(async () => {
    const current = await window.neoDeskPet.getSettings()
    return { apiKey: current.ai.apiKey, hasApiKey: current.ai.hasApiKey }
  })
  assert(
    restartSecretExposure.apiKey === '' && restartSecretExposure.hasApiKey === true,
    'renderer secret state was not restored safely after restart',
  )
  const restartProxyRequest = await restartedChat.evaluate(async () => {
    const response = await window.neoDeskPet.aiHttpRequest({
      credential: { kind: 'main' },
      body: { model: 'ipc-smoke-restart', messages: [] },
    })
    return { ok: response.ok, status: response.status, body: JSON.parse(response.bodyText) }
  })
  assert(restartProxyRequest.ok && restartProxyRequest.body?.via === 'main-process', 'AI proxy failed after restart')
  assert(aiRequests.length === 3 && aiRequests.at(-1)?.authMatches, 'AI key was not restored after restart')
  assert(aiRequests.at(-1)?.path === '/v1/chat/completions', 'AI proxy used an unexpected endpoint after restart')

  const report = {
    generatedAt: new Date().toISOString(),
    executablePath,
    outputDir,
    urls,
    keys,
    windowSizes: {
      defaults: defaultWindowSizes,
    },
    settingsNavigation: {
      onCreate: settingsNavigationOnCreate?.trim() ?? '',
      onReuse: settingsNavigationOnReuse?.trim() ?? '',
    },
    runtimeErrors,
    aiProxy: {
      request: aiProxyRequest,
      streamReceived: aiProxyStream.text.includes('代理'),
      requests: aiRequests,
      rendererSecretExposure,
      persistedFiles: {
        settingsFile,
        secretsFile,
        settingsContainsPlaintextKey: false,
        secretsContainsPlaintextKey: false,
      },
      restart: {
        mainRoute: restartMainRoute,
        normalizedLegacyWindowSizes,
        rendererSecretExposure: restartSecretExposure,
        request: restartProxyRequest,
      },
    },
    routeTamper,
    childWindowDenied,
  }
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close().catch(() => undefined)
  await new Promise((resolve) => aiServer.close(() => resolve()))
}
