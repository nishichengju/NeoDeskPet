import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const outputDir = path.join(projectRoot, 'artifacts', `ipc-security-smoke-${stamp}`)
const userDataDir = path.join(outputDir, 'userData')
const settingsFile = path.join(userDataDir, 'neodeskpet-settings.json')
const secretsFile = path.join(userDataDir, 'neodeskpet-secrets.json')
const memoryDatabaseFile = path.join(userDataDir, 'neodeskpet-memory.sqlite3')
const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const packagedDir = path.join(projectRoot, 'release', packageVersion, 'win-unpacked')
const packagedExeName = existsSync(packagedDir)
  ? readdirSync(packagedDir).find((name) => name.toLowerCase().endsWith('.exe'))
  : undefined
const packagedExe = packagedExeName ? path.join(packagedDir, packagedExeName) : ''
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const mcpSmokeServerScript = path.join(projectRoot, 'scripts', 'fixtures', 'ipc-smoke-mcp-server.mjs')

mkdirSync(userDataDir, { recursive: true })
const taskMediaDir = path.join(userDataDir, 'task-output')
const taskMediaImage = path.join(taskMediaDir, 'ipc-task-tool-media.png')
const taskMediaManifest = path.join(taskMediaDir, 'ipc-task-tool-media.txt')
const visionSmokeImage = path.join(outputDir, 'agent-vision-smoke.png')
const smokePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
mkdirSync(taskMediaDir, { recursive: true })
writeFileSync(taskMediaImage, smokePng)
writeFileSync(taskMediaManifest, `${taskMediaImage}\n`, 'utf8')
writeFileSync(visionSmokeImage, smokePng)

const legacyMemoryPersonaId = 'ipc-legacy-persona'
const legacyMemoryContent = 'IPC legacy searchable memory'
const legacyMemoryCreatedAt = Date.now()
const legacyMemoryDatabase = new DatabaseSync(memoryDatabaseFile)
legacyMemoryDatabase.exec(`
  CREATE TABLE persona (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE memory (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    persona_id TEXT,
    scope TEXT NOT NULL DEFAULT 'persona',
    kind TEXT NOT NULL,
    role TEXT,
    session_id TEXT,
    message_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO persona (id, name, prompt, created_at, updated_at)
    VALUES ('${legacyMemoryPersonaId}', 'IPC Legacy Persona', 'legacy prompt', 100, 200);
  INSERT INTO memory (id, persona_id, scope, kind, role, session_id, message_id, content, created_at)
    VALUES ('ipc-legacy-memory', '${legacyMemoryPersonaId}', 'persona', 'chat', 'user', 'legacy-session', 'legacy-message', '${legacyMemoryContent}', ${legacyMemoryCreatedAt});
`)
legacyMemoryDatabase.close()

const aiSmokeKey = 'ipc-smoke-main-key'
const aiRequests = []
const ttsRequests = []
const aiServer = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (['/tts', '/set_gpt_weights', '/set_sovits_weights'].includes(requestUrl.pathname)) {
    ttsRequests.push({ path: requestUrl.pathname, method: request.method, bodyText })
    if (requestUrl.pathname !== '/tts') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, endpoint: requestUrl.pathname }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'audio/wav' })
    response.write(Buffer.from([1, 2, 3]))
    response.end(Buffer.from([4, 5, 6]))
    return
  }

  const body = bodyText ? JSON.parse(bodyText) : {}
  const messageText = JSON.stringify(body.messages ?? [])
  const hasAgentToolResult = messageText.includes('<<<[TOOL_RESULT]>>>')
  const hasNativeToolResult = Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'tool')
  const hasVisionInput =
    Array.isArray(body.messages) &&
    body.messages.some(
      (message) =>
        Array.isArray(message?.content) &&
        message.content.some((part) => part?.type === 'image_url' && typeof part?.image_url?.url === 'string'),
    )
  const isClaudeAgent = body.model === 'ipc-agent-claude-smoke'
  const isNativeAgent = body.model === 'ipc-agent-native-smoke'
  const isAutoFallbackAgent = body.model === 'ipc-agent-auto-fallback-smoke'
  const isMmvectorWorkflowAgent = body.model === 'ipc-agent-mmvector-workflow-smoke'
  const recordedRequest = {
    path: request.url,
    authMatches: isClaudeAgent
      ? request.headers['x-api-key'] === aiSmokeKey
      : request.headers.authorization === `Bearer ${aiSmokeKey}`,
    streaming: body.stream === true,
    model: body.model,
    hasAgentToolResult,
    hasNativeToolResult,
    hasVisionInput,
    claudePayloadMatches:
      isClaudeAgent &&
      typeof body.system === 'string' &&
      Array.isArray(body.messages) &&
      body.messages.every((message) => message?.role === 'user' || message?.role === 'assistant'),
    nativePayloadMatches:
      (isNativeAgent || isAutoFallbackAgent) &&
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      body.tool_choice === 'auto',
  }
  aiRequests.push(recordedRequest)

  const modelRequestCount = aiRequests.filter((item) => item.model === body.model).length
  if (body.model === 'ipc-agent-smoke' && body.stream === true && !hasAgentToolResult && modelRequestCount === 1) {
    recordedRequest.simulatedStatus = 503
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'temporary agent smoke failure' } }))
    return
  }

  if (isAutoFallbackAgent && recordedRequest.nativePayloadMatches && hasNativeToolResult) {
    recordedRequest.simulatedStatus = 400
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'thought_signature is required for native tool continuation' } }))
    return
  }

  if (body.stream === true) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (isClaudeAgent) {
      const frames = [
        { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_delta', delta: { text: 'Claude provider smoke complete.' } },
        { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 4 } },
        { type: 'message_stop' },
      ]
        .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
        .join('')
      const splitAt = Math.max(1, Math.floor(frames.length / 2))
      response.write(frames.slice(0, splitAt))
      await new Promise((resolve) => setTimeout(resolve, 5))
      response.end(frames.slice(splitAt))
      return
    }
    if (isNativeAgent) {
      const payloads = hasNativeToolResult
        ? [{ choices: [{ delta: { content: 'Native provider smoke complete.' } }] }]
        : [
            {
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'native-smoke-call',
                        type: 'function',
                        function: { name: 'ndp_delay_', arguments: '{"ms":' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { name: 'sleep', arguments: '1}' } }],
                  },
                },
              ],
            },
          ]
      const frames = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`
      const splitAt = Math.max(1, Math.floor(frames.length / 2))
      response.write(frames.slice(0, splitAt))
      await new Promise((resolve) => setTimeout(resolve, 5))
      response.end(frames.slice(splitAt))
      return
    }
    if (isAutoFallbackAgent && recordedRequest.nativePayloadMatches) {
      const payloads = [
        {
          choices: [
            {
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'auto-fallback-smoke-call',
                    type: 'function',
                    function: { name: 'ndp_delay_sleep', arguments: '{"ms":1}' },
                  },
                ],
              },
            },
          ],
        },
      ]
      const frames = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`
      response.end(frames)
      return
    }
    const content =
      isMmvectorWorkflowAgent
        ? hasAgentToolResult
          ? 'MMVector workflow smoke complete.'
          : [
              '<<<[TOOL_REQUEST]>>>',
              'tool_name:「始」workflow.mmvector_video_qa「末」',
              'input_json:「始」{"searchQuery":"ipc smoke video","question":"What is shown?"}「末」',
              '<<<[END_TOOL_REQUEST]>>>',
            ].join('\n')
        : body.model === 'ipc-agent-smoke'
        ? hasAgentToolResult
          ? 'Agent protocol smoke complete.'
          : [
              '<<<[TOOL_REQUEST]>>>',
              'tool_name:「始」delay.sleep「末」',
              'input_json:「始」{"ms":1}「末」',
              '<<<[END_TOOL_REQUEST]>>>',
            ].join('\n')
        : isAutoFallbackAgent && hasAgentToolResult
          ? 'Auto fallback smoke complete.'
          : '代理'
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
    const splitAt = Math.max(1, Math.floor(frames.length / 2))
    response.write(frames.slice(0, splitAt))
    await new Promise((resolve) => setTimeout(resolve, 5))
    response.end(frames.slice(splitAt))
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

  const orbStateRoundTrip = await orb.evaluate(async () => {
    const initial = await window.neoDeskPet.getOrbUiState()
    const panel = await window.neoDeskPet.setOrbUiState('panel', { focus: false, animate: false })
    const toggled = await window.neoDeskPet.toggleOrbUiState()
    const overlay = await window.neoDeskPet.setOrbOverlayBounds({ width: 560, height: 320, focus: false })
    const cleared = await window.neoDeskPet.clearOrbOverlayBounds({ focus: false })
    const final = await window.neoDeskPet.getOrbUiState()
    return { initial, panel, toggled, overlay, cleared, final }
  })
  assert(orbStateRoundTrip.initial.state === 'ball', 'Orb initial UI state was not ball')
  assert(orbStateRoundTrip.panel.state === 'panel', 'Orb panel state update failed')
  assert(orbStateRoundTrip.toggled.state === 'ball' && orbStateRoundTrip.final.state === 'ball', 'Orb state toggle failed')
  assert(orbStateRoundTrip.overlay.ok && orbStateRoundTrip.cleared.ok, 'Orb overlay bounds round trip failed')

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

  const ttsOptionsAvailable = await settings.evaluate(async (origin) => {
    await window.neoDeskPet.setTtsSettings({ baseUrl: origin })
    const options = await window.neoDeskPet.listTtsOptions()
    return Boolean(options?.ttsRoot)
  }, aiServerOrigin)
  const ttsProxy = await pet.evaluate(async (origin) => {
    const json = await window.neoDeskPet.ttsHttpGetJson(`${origin}/set_gpt_weights?weights_path=smoke.ckpt`)
    const audio = await window.neoDeskPet.ttsHttpRequestArrayBuffer({
      url: `${origin}/tts`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'smoke' }),
    })
    const stream = await new Promise((resolve, reject) => {
      const bytes = []
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('TTS proxy stream timed out'))
      }, 10_000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        offChunk()
        offDone()
        offError()
      }
      const offChunk = window.neoDeskPet.onTtsHttpStreamChunk((payload) => bytes.push(...payload.chunk))
      const offDone = window.neoDeskPet.onTtsHttpStreamDone((payload) => {
        cleanup()
        resolve({ streamId: payload.streamId, bytes })
      })
      const offError = window.neoDeskPet.onTtsHttpStreamError((payload) => {
        cleanup()
        reject(new Error(payload.error || 'TTS proxy stream failed'))
      })
      void window.neoDeskPet.ttsHttpStreamStart({
        url: `${origin}/tts`,
        method: 'POST',
        body: JSON.stringify({ text: 'stream' }),
      }).catch((error) => {
        cleanup()
        reject(error)
      })
    })
    let deniedPath = false
    try {
      await window.neoDeskPet.ttsHttpGetJson(`${origin}/admin`)
    } catch {
      deniedPath = true
    }
    return {
      json,
      audio: { ...audio, arrayBuffer: Array.from(new Uint8Array(audio.arrayBuffer)) },
      stream,
      deniedPath,
    }
  }, aiServerOrigin)

  const petEnqueuePromise = pet.evaluate(() => new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      off()
      reject(new Error('TTS enqueue relay timed out'))
    }, 10_000)
    const off = window.neoDeskPet.onTtsEnqueue((payload) => {
      window.clearTimeout(timeout)
      off()
      resolve(payload)
    })
  }))
  await chat.evaluate(() => window.neoDeskPet.enqueueTtsUtterance({
    utteranceId: 'ipc-tts-relay',
    mode: 'replace',
    segments: ['第一句'],
  }))
  const ttsEnqueueRelay = await petEnqueuePromise

  const chatSegmentPromise = chat.evaluate(() => new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      off()
      reject(new Error('TTS segment relay timed out'))
    }, 10_000)
    const off = window.neoDeskPet.onTtsSegmentStarted((payload) => {
      window.clearTimeout(timeout)
      off()
      resolve(payload)
    })
  }))
  await pet.evaluate(() => window.neoDeskPet.reportTtsSegmentStarted({
    utteranceId: 'ipc-tts-relay',
    segmentIndex: 0,
    text: '第一句',
  }))
  const ttsSegmentRelay = await chatSegmentPromise

  assert(ttsOptionsAvailable, 'TTS options API was unavailable')
  assert(ttsProxy.json.ok && ttsProxy.json.json?.endpoint === '/set_gpt_weights', 'TTS JSON proxy failed')
  assert(ttsProxy.audio.ok && ttsProxy.audio.arrayBuffer.length === 6, 'TTS array-buffer proxy failed')
  assert(ttsProxy.stream.bytes.length === 6, 'TTS stream proxy failed')
  assert(ttsProxy.deniedPath, 'TTS proxy allowed an unexpected endpoint')
  assert(ttsRequests.length === 3 && ttsRequests.every((request) => request.method === 'GET' || request.method === 'POST'), 'TTS proxy request set was incomplete')
  assert(ttsEnqueueRelay.utteranceId === 'ipc-tts-relay', 'Chat to Pet TTS relay failed')
  assert(ttsSegmentRelay.utteranceId === 'ipc-tts-relay', 'Pet to Chat TTS relay failed')

  const petPresentationPromise = pet.evaluate(() => new Promise((resolve, reject) => {
    const state = { expression: '', bubble: '', preview: null, compose: null }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Presentation relay timed out'))
    }, 10_000)
    const maybeDone = () => {
      if (!state.expression || !state.bubble || !state.preview || !state.compose) return
      cleanup()
      resolve(state)
    }
    const cleanup = () => {
      window.clearTimeout(timeout)
      offExpression()
      offBubble()
      offPreview()
      offCompose()
    }
    const offExpression = window.neoDeskPet.onLive2dExpression((value) => {
      state.expression = value
      maybeDone()
    })
    const offBubble = window.neoDeskPet.onBubbleMessage((value) => {
      state.bubble = value
      maybeDone()
    })
    const offPreview = window.neoDeskPet.onBubblePreview((value) => {
      state.preview = value
      maybeDone()
    })
    const offCompose = window.neoDeskPet.onAsrComposePreview((value) => {
      state.compose = value
      maybeDone()
    })
  }))
  await chat.evaluate(() => {
    window.neoDeskPet.triggerExpression('ipc-expression')
    window.neoDeskPet.sendBubbleMessage('ipc bubble')
    window.neoDeskPet.sendBubblePreview({ text: 'ipc preview', placeholder: true, autoHideDelay: 321.9 })
    window.neoDeskPet.syncAsrComposePreview({ baseText: 'ipc compose', clearFinals: true })
  })
  const presentationRelay = await petPresentationPromise

  const chatAsrPromise = chat.evaluate(() => new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      off()
      reject(new Error('ASR transcript relay timed out'))
    }, 10_000)
    const off = window.neoDeskPet.onAsrTranscript((text) => {
      window.clearTimeout(timeout)
      off()
      resolve(text)
    })
    window.neoDeskPet.notifyAsrTranscriptReady()
  }))
  await pet.evaluate(() => {
    window.neoDeskPet.reportLive2dCapabilities({
      modelJsonUrl: 'file:///ipc/model.json',
      updatedAt: Date.now(),
      parameters: [{ id: 'ParamAngleX', min: -30, max: 30, def: 0 }],
    })
    window.neoDeskPet.reportAsrTranscript('ipc transcript')
  })
  const asrTranscriptRelay = await chatAsrPromise

  assert(presentationRelay.expression === 'ipc-expression', 'Live2D expression relay failed')
  assert(presentationRelay.bubble === 'ipc bubble', 'Bubble message relay failed')
  assert(presentationRelay.preview?.text === 'ipc preview' && presentationRelay.preview?.autoHideDelay === 321, 'Bubble preview normalization failed')
  assert(presentationRelay.compose?.baseText === 'ipc compose' && presentationRelay.compose?.clearFinals === true, 'ASR compose preview relay failed')
  assert(asrTranscriptRelay === 'ipc transcript', 'ASR transcript relay failed')

  const chatPersistenceBeforeRestart = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createChatSession('IPC Smoke Session', 'default')
    await window.neoDeskPet.setCurrentChatSession(created.id)
    await window.neoDeskPet.addChatMessage(created.id, {
      id: 'ipc-smoke-user',
      role: 'user',
      content: '持久化问题',
      createdAt: 1,
    })
    await window.neoDeskPet.addChatMessage(created.id, {
      id: 'ipc-smoke-assistant',
      role: 'assistant',
      content: '初始回答',
      createdAt: 2,
    })
    await window.neoDeskPet.updateChatMessage(created.id, 'ipc-smoke-assistant', '编辑回答')
    await window.neoDeskPet.updateChatMessageRecord(created.id, 'ipc-smoke-assistant', {
      content: '结构化更新',
      updatedAt: 3,
    })
    await window.neoDeskPet.setChatAutoExtractCursor(created.id, 2)
    await window.neoDeskPet.setChatAutoExtractMeta(created.id, {
      autoExtractLastRunAt: 4,
      autoExtractLastWriteCount: 1,
      autoExtractLastError: '',
    })
    await window.neoDeskPet.renameChatSession(created.id, 'IPC Smoke Renamed')
    const loaded = await window.neoDeskPet.getChatSession(created.id)
    const listed = await window.neoDeskPet.listChatSessions()
    return { sessionId: created.id, loaded, listed }
  })
  assert(chatPersistenceBeforeRestart.loaded.name === 'IPC Smoke Renamed', 'chat rename was not persisted')
  assert(chatPersistenceBeforeRestart.loaded.messages.length === 2, 'chat messages were not persisted before restart')
  assert(
    chatPersistenceBeforeRestart.loaded.messages[1]?.content === '结构化更新',
    'chat message updates were not persisted before restart',
  )
  assert(chatPersistenceBeforeRestart.loaded.autoExtractCursor === 2, 'chat auto-extract cursor was not persisted')
  assert(chatPersistenceBeforeRestart.loaded.autoExtractLastWriteCount === 1, 'chat auto-extract metadata was not persisted')
  assert(
    chatPersistenceBeforeRestart.listed.currentSessionId === chatPersistenceBeforeRestart.sessionId,
    'chat current session was not persisted',
  )

  const taskPersistenceBeforeRestart = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Smoke Task',
      why: 'Verify packaged task storage',
      steps: [{ title: 'No-op persisted step' }],
    })
    const deadline = Date.now() + 10_000
    let loaded = await window.neoDeskPet.getTask(created.id)
    while (loaded && (loaded.status === 'pending' || loaded.status === 'running' || loaded.status === 'paused')) {
      if (Date.now() >= deadline) throw new Error(`task did not finish before timeout: ${loaded.status}`)
      await new Promise((resolve) => window.setTimeout(resolve, 50))
      loaded = await window.neoDeskPet.getTask(created.id)
    }
    const listed = await window.neoDeskPet.listTasks()
    return { taskId: created.id, loaded, listed }
  })
  assert(taskPersistenceBeforeRestart.loaded?.status === 'done', 'task did not finish before restart')
  assert(taskPersistenceBeforeRestart.loaded?.steps[0]?.output === '跳过（无 tool）', 'task step output was not persisted before restart')
  assert(
    taskPersistenceBeforeRestart.listed.items.some((task) => task.id === taskPersistenceBeforeRestart.taskId),
    'created task was not listed before restart',
  )

  const taskLifecycle = await chat.evaluate(async (mediaManifestPath) => {
    const waitForStatus = async (taskId, expectedStatuses, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await window.neoDeskPet.getTask(taskId)
        if (current && expectedStatuses.includes(current.status)) return current
        await new Promise((resolve) => window.setTimeout(resolve, 25))
      }
      const current = await window.neoDeskPet.getTask(taskId)
      throw new Error(`task ${taskId} did not reach ${expectedStatuses.join('/')} (current=${current?.status ?? 'missing'})`)
    }
    const waitForActiveStep = async (taskId, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await window.neoDeskPet.getTask(taskId)
        const step = current?.steps?.[current.currentStepIndex]
        if (current?.status === 'running' && step?.status === 'running') return current
        await new Promise((resolve) => window.setTimeout(resolve, 10))
      }
      const current = await window.neoDeskPet.getTask(taskId)
      throw new Error(`task ${taskId} did not expose an active step (current=${current?.status ?? 'missing'})`)
    }
    const steps = Array.from({ length: 12 }, (_, index) => ({ title: `No-op lifecycle step ${index + 1}` }))

    const pausable = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Pause Resume Task',
      steps,
    })
    const runningBeforePause = await waitForStatus(pausable.id, ['running'])
    const paused = await window.neoDeskPet.pauseTask(pausable.id)
    const pausedStepIndex = paused?.currentStepIndex ?? -1
    await new Promise((resolve) => window.setTimeout(resolve, 180))
    const whilePaused = await window.neoDeskPet.getTask(pausable.id)
    const resumed = await window.neoDeskPet.resumeTask(pausable.id)
    const completed = await waitForStatus(pausable.id, ['done', 'failed', 'canceled'])

    const cancelable = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Cancel Task',
      steps,
    })
    const runningBeforeCancel = await waitForActiveStep(cancelable.id)
    const canceled = await window.neoDeskPet.cancelTask(cancelable.id)
    await new Promise((resolve) => window.setTimeout(resolve, 180))
    const afterCancel = await window.neoDeskPet.getTask(cancelable.id)

    const direct = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Direct Tool Task',
      steps: [{ title: 'Direct delay', tool: 'delay.sleep', input: '{"ms":1}' }],
    })
    const directCompleted = await waitForStatus(direct.id, ['done', 'failed', 'canceled'])

    const media = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Direct Tool Media Task',
      steps: [
        {
          title: 'Read image manifest',
          tool: 'file.read',
          input: JSON.stringify({ path: mediaManifestPath }),
        },
      ],
    })
    const mediaCompleted = await waitForStatus(media.id, ['done', 'failed', 'canceled'])

    const failing = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Direct Tool Failure Task',
      steps: [{ title: 'Unknown direct tool', tool: 'missing.tool', input: '{"value":1}' }],
    })
    const failed = await waitForStatus(failing.id, ['done', 'failed', 'canceled'])
    const pauseDismissed = await window.neoDeskPet.dismissTask(pausable.id)
    const cancelDismissed = await window.neoDeskPet.dismissTask(cancelable.id)
    const directDismissed = await window.neoDeskPet.dismissTask(direct.id)
    const mediaDismissed = await window.neoDeskPet.dismissTask(media.id)
    const failedDismissed = await window.neoDeskPet.dismissTask(failing.id)

    return {
      runningBeforePause,
      paused,
      pausedStepIndex,
      whilePaused,
      resumed,
      completed,
      runningBeforeCancel,
      canceled,
      afterCancel,
      directCompleted,
      mediaCompleted,
      failed,
      pauseDismissed,
      cancelDismissed,
      directDismissed,
      mediaDismissed,
      failedDismissed,
    }
  }, taskMediaManifest)
  assert(taskLifecycle.runningBeforePause.status === 'running', 'pause/resume task never entered running state')
  assert(taskLifecycle.paused?.status === 'paused', 'task pause did not persist paused state')
  assert(taskLifecycle.whilePaused?.status === 'paused', 'task left paused state without resume')
  assert(
    taskLifecycle.whilePaused?.currentStepIndex === taskLifecycle.pausedStepIndex,
    'task step cursor advanced while paused',
  )
  assert(taskLifecycle.resumed?.status === 'running', 'task resume did not persist running state')
  assert(taskLifecycle.completed.status === 'done', `resumed task did not complete: ${taskLifecycle.completed.status}`)
  assert(taskLifecycle.runningBeforeCancel.status === 'running', 'cancel task never entered running state')
  assert(taskLifecycle.canceled?.status === 'canceled', 'task cancel did not persist canceled state')
  assert(taskLifecycle.afterCancel?.status === 'canceled', 'canceled task changed state after cancellation')
  assert(taskLifecycle.afterCancel?.steps?.[taskLifecycle.afterCancel.currentStepIndex]?.status === 'skipped', 'canceled task left its active step running')
  assert(taskLifecycle.afterCancel?.steps?.[taskLifecycle.afterCancel.currentStepIndex]?.error === '任务已取消', 'canceled step did not record its terminal reason')
  assert(taskLifecycle.directCompleted?.status === 'done', `direct tool task failed: ${taskLifecycle.directCompleted?.lastError ?? 'missing'}`)
  assert(taskLifecycle.directCompleted?.steps?.[0]?.status === 'done', 'direct tool step was not marked done')
  assert(
    taskLifecycle.directCompleted?.toolRuns?.some((run) => run.toolName === 'delay.sleep' && run.status === 'done'),
    'direct tool task did not persist its done toolRun',
  )
  assert(
    taskLifecycle.mediaCompleted?.status === 'done',
    `direct media task failed: ${taskLifecycle.mediaCompleted?.lastError ?? 'missing'}`,
  )
  assert(taskLifecycle.mediaCompleted?.steps?.[0]?.status === 'done', 'direct media step was not marked done')
  assert(
    taskLifecycle.mediaCompleted?.toolRuns?.some(
      (run) =>
        run.toolName === 'file.read' &&
        run.status === 'done' &&
        Array.isArray(run.imagePaths) &&
        run.imagePaths.includes(taskMediaImage),
    ),
    'direct media toolRun did not persist the referenced local image',
  )
  assert(taskLifecycle.failed?.status === 'failed', 'unknown direct tool task was not marked failed')
  assert(taskLifecycle.failed?.steps?.[0]?.status === 'failed', 'unknown direct tool step was not marked failed')
  assert(
    taskLifecycle.failed?.toolRuns?.some((run) => run.toolName === 'missing.tool' && run.status === 'error'),
    'unknown direct tool task did not persist its error toolRun',
  )
  assert(
    taskLifecycle.pauseDismissed?.ok &&
      taskLifecycle.cancelDismissed?.ok &&
      taskLifecycle.directDismissed?.ok &&
      taskLifecycle.mediaDismissed?.ok &&
      taskLifecycle.failedDismissed?.ok,
    'task lifecycle cleanup failed',
  )

  await settings.evaluate(async () => {
    await window.neoDeskPet.setAISettings({ model: 'ipc-agent-smoke' })
    await window.neoDeskPet.setOrchestratorSettings({ toolCallingMode: 'text', skillEnabled: false })
  })
  const taskAgentProtocol = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Agent Text Protocol Task',
      steps: [
        {
          title: 'Run text tool protocol',
          tool: 'agent.run',
          input: JSON.stringify({ request: 'Run the smoke delay tool, then finish.', mode: 'text', maxTurns: 3 }),
        },
      ],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  })
  const taskAgentRequests = aiRequests.filter((request) => request.model === 'ipc-agent-smoke')
  assert(taskAgentProtocol.completed?.status === 'done', `agent text protocol task failed: ${taskAgentProtocol.completed?.lastError ?? 'missing'}`)
  assert(
    taskAgentProtocol.completed?.steps[0]?.output === 'Agent protocol smoke complete.',
    'agent text protocol final output was not persisted',
  )
  assert(
    taskAgentProtocol.completed?.toolRuns?.some((run) => run.toolName === 'delay.sleep' && run.status === 'done'),
    'agent text protocol did not execute and record delay.sleep',
  )
  assert(
    taskAgentRequests.length === 3 &&
      taskAgentRequests.every((request) => request.authMatches) &&
      taskAgentRequests[0]?.simulatedStatus === 503 &&
      taskAgentRequests[0]?.hasAgentToolResult === false &&
      taskAgentRequests[1]?.hasAgentToolResult === false &&
      taskAgentRequests[2]?.hasAgentToolResult === true,
    'agent text protocol did not retry and round-trip TOOL_REQUEST/TOOL_RESULT through the packaged task runner',
  )
  assert(taskAgentProtocol.dismissed?.ok, 'agent text protocol task cleanup failed')

  const taskAgentMmvectorMcp = await settings.evaluate(
    async ({ command, serverScript, cwd }) => {
      await window.neoDeskPet.setMcpSettings({
        enabled: true,
        servers: [
          {
            id: 'mmvector',
            enabled: true,
            label: 'IPC Smoke MMVector',
            transport: 'stdio',
            command,
            args: [serverScript],
            cwd,
          },
        ],
      })
      await window.neoDeskPet.setAISettings({ model: 'ipc-agent-mmvector-workflow-smoke' })
      await window.neoDeskPet.setOrchestratorSettings({ toolCallingMode: 'text', skillEnabled: false })

      const deadline = Date.now() + 15_000
      let state = await window.neoDeskPet.getMcpState()
      while (Date.now() < deadline) {
        const server = state.servers.find((item) => item.id === 'mmvector')
        if (
          server?.status === 'connected' &&
          server.tools.some((tool) => tool.toolName === 'mcp.mmvector.search_by_text') &&
          server.tools.some((tool) => tool.toolName === 'mcp.mmvector.capture_image')
        ) {
          break
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50))
        state = await window.neoDeskPet.getMcpState()
      }
      return state
    },
    { command: process.execPath, serverScript: mcpSmokeServerScript, cwd: projectRoot },
  )
  assert(
    taskAgentMmvectorMcp.servers.some(
      (server) =>
        server.id === 'mmvector' &&
        server.status === 'connected' &&
        server.tools.some((tool) => tool.toolName === 'mcp.mmvector.search_by_text') &&
        server.tools.some((tool) => tool.toolName === 'mcp.mmvector.capture_image'),
    ),
    'packaged MCP smoke server did not expose the expected tools',
  )

  const taskMcpDirect = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Direct MCP Media Task',
      steps: [{ title: 'Capture MCP image', tool: 'mcp.mmvector.capture_image', input: '{}' }],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  })
  assert(
    taskMcpDirect.completed?.status === 'done',
    `direct MCP media task failed: ${taskMcpDirect.completed?.lastError ?? 'missing'}`,
  )
  assert(taskMcpDirect.completed?.steps?.[0]?.status === 'done', 'direct MCP media step was not marked done')
  assert(
    taskMcpDirect.completed?.toolRuns?.some(
      (run) =>
        run.toolName === 'mcp.mmvector.capture_image' &&
        run.status === 'done' &&
        run.outputPreview?.includes('IPC MCP image captured.') &&
        Array.isArray(run.imagePaths) &&
        run.imagePaths.length === 1 &&
        run.imagePaths[0].toLowerCase().endsWith('.png'),
    ),
    'direct MCP media toolRun did not persist its structured image',
  )
  assert(taskMcpDirect.dismissed?.ok, 'direct MCP media task cleanup failed')

  const taskAgentMmvector = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Agent MMVector Workflow Task',
      steps: [
        {
          title: 'Run MMVector workflow through Agent',
          tool: 'agent.run',
          input: JSON.stringify({ request: 'Run the mmvector workflow smoke tool, then finish.', mode: 'text', maxTurns: 3 }),
        },
      ],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  })
  const taskAgentMmvectorRequests = aiRequests.filter(
    (request) => request.model === 'ipc-agent-mmvector-workflow-smoke',
  )
  assert(
    taskAgentMmvector.completed?.status === 'done',
    `agent mmvector workflow task failed: ${taskAgentMmvector.completed?.lastError ?? 'missing'}`,
  )
  assert(
    taskAgentMmvector.completed?.steps[0]?.output === 'MMVector workflow smoke complete.',
    'agent mmvector workflow final output was not persisted',
  )
  assert(
    taskAgentMmvector.completed?.toolRuns?.some(
      (run) =>
        run.toolName === 'workflow.mmvector_video_qa' &&
        run.status === 'done' &&
        run.outputPreview?.includes('mmvector 未命中任何视频'),
    ),
    'agent did not execute workflow.mmvector_video_qa through the unified tool adapter',
  )
  assert(
    taskAgentMmvectorRequests.length === 2 &&
      taskAgentMmvectorRequests[0]?.hasAgentToolResult === false &&
      taskAgentMmvectorRequests[1]?.hasAgentToolResult === true,
    'agent mmvector workflow did not round-trip TOOL_REQUEST/TOOL_RESULT',
  )
  assert(taskAgentMmvector.dismissed?.ok, 'agent mmvector workflow task cleanup failed')
  await settings.evaluate(() => window.neoDeskPet.setMcpSettings({ enabled: false, servers: [] }))

  await settings.evaluate(() =>
    window.neoDeskPet.setAISettings({ model: 'ipc-agent-native-smoke', apiMode: 'openai-compatible' }),
  )
  const taskAgentNative = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Agent Native Provider Task',
      steps: [
        {
          title: 'Run native tool call stream',
          tool: 'agent.run',
          input: JSON.stringify({ request: 'Run the native smoke delay tool, then finish.', mode: 'native', maxTurns: 3 }),
        },
      ],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  })
  const taskAgentNativeRequests = aiRequests.filter((request) => request.model === 'ipc-agent-native-smoke')
  assert(taskAgentNative.completed?.status === 'done', `agent native task failed: ${taskAgentNative.completed?.lastError ?? 'missing'}`)
  assert(
    taskAgentNative.completed?.steps[0]?.output === 'Native provider smoke complete.',
    'agent native final output was not persisted',
  )
  assert(
    taskAgentNative.completed?.toolRuns?.some((run) => run.toolName === 'delay.sleep' && run.status === 'done'),
    'agent native stream did not merge and execute delay.sleep',
  )
  assert(
    taskAgentNativeRequests.length === 2 &&
      taskAgentNativeRequests.every((request) => request.authMatches && request.nativePayloadMatches) &&
      taskAgentNativeRequests[0]?.hasNativeToolResult === false &&
      taskAgentNativeRequests[1]?.hasNativeToolResult === true,
    'agent native tool_calls did not round-trip through role=tool messages',
  )
  assert(taskAgentNative.dismissed?.ok, 'agent native task cleanup failed')

  await settings.evaluate(() =>
    window.neoDeskPet.setAISettings({
      model: 'ipc-agent-auto-fallback-smoke',
      apiMode: 'openai-compatible',
      visionRoutingMode: 'main-only',
      visionCapability: 'supported',
    }),
  )
  const taskAgentAutoFallback = await chat.evaluate(async (imagePath) => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Agent Auto Fallback Task',
      visualArtifacts: [
        {
          id: 'ipc-agent-vision-upload',
          path: imagePath,
          source: 'upload',
          groupId: 'ipc-agent-vision-group',
          index: 1,
          total: 1,
          createdAt: Date.now(),
        },
      ],
      initialVisionIds: ['ipc-agent-vision-upload'],
      steps: [
        {
          title: 'Run native then fallback to text',
          tool: 'agent.run',
          input: JSON.stringify({ request: 'Run the fallback smoke delay tool, then finish.', mode: 'auto', maxTurns: 3 }),
        },
      ],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  }, visionSmokeImage)
  const taskAgentAutoFallbackRequests = aiRequests.filter(
    (request) => request.model === 'ipc-agent-auto-fallback-smoke',
  )
  assert(
    taskAgentAutoFallback.completed?.status === 'done',
    `agent auto fallback task failed: ${taskAgentAutoFallback.completed?.lastError ?? 'missing'}`,
  )
  assert(
    taskAgentAutoFallback.completed?.steps[0]?.output === 'Auto fallback smoke complete.',
    'agent auto fallback final output was not persisted',
  )
  assert(
    taskAgentAutoFallback.completed?.toolRuns?.filter(
      (run) => run.toolName === 'delay.sleep' && run.status === 'done',
    ).length === 1,
    'agent auto fallback did not preserve the single native tool execution',
  )
  assert(
    taskAgentAutoFallbackRequests.length === 3 &&
      taskAgentAutoFallbackRequests[0]?.nativePayloadMatches === true &&
      taskAgentAutoFallbackRequests[0]?.hasNativeToolResult === false &&
      taskAgentAutoFallbackRequests[1]?.nativePayloadMatches === true &&
      taskAgentAutoFallbackRequests[1]?.hasNativeToolResult === true &&
      taskAgentAutoFallbackRequests[1]?.simulatedStatus === 400 &&
      taskAgentAutoFallbackRequests[2]?.nativePayloadMatches === false &&
      taskAgentAutoFallbackRequests[2]?.hasAgentToolResult === true &&
      taskAgentAutoFallbackRequests.every((request) => request.hasVisionInput === true),
    'agent auto fallback did not replay the completed native tool result and main-model image into text mode',
  )
  assert(taskAgentAutoFallback.dismissed?.ok, 'agent auto fallback task cleanup failed')

  await settings.evaluate(() =>
    window.neoDeskPet.setAISettings({
      model: 'ipc-agent-claude-smoke',
      apiMode: 'claude',
      visionRoutingMode: 'off',
      visionCapability: 'auto',
    }),
  )
  const taskAgentClaude = await chat.evaluate(async () => {
    const created = await window.neoDeskPet.createTask({
      queue: 'chat',
      title: 'IPC Agent Claude Provider Task',
      steps: [
        {
          title: 'Run Claude provider stream',
          tool: 'agent.run',
          input: JSON.stringify({ request: 'Return the Claude provider smoke result.', mode: 'text', maxTurns: 1 }),
        },
      ],
    })
    const deadline = Date.now() + 15_000
    let completed = null
    while (Date.now() < deadline) {
      completed = await window.neoDeskPet.getTask(created.id)
      if (completed && ['done', 'failed', 'canceled'].includes(completed.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    const dismissed = await window.neoDeskPet.dismissTask(created.id)
    return { taskId: created.id, completed, dismissed }
  })
  await settings.evaluate(() => window.neoDeskPet.setAISettings({ model: 'ipc-smoke', apiMode: 'openai-compatible' }))
  const taskAgentClaudeRequests = aiRequests.filter((request) => request.model === 'ipc-agent-claude-smoke')
  assert(taskAgentClaude.completed?.status === 'done', `agent Claude task failed: ${taskAgentClaude.completed?.lastError ?? 'missing'}`)
  assert(
    taskAgentClaude.completed?.steps[0]?.output === 'Claude provider smoke complete.',
    'agent Claude final output was not persisted',
  )
  assert(
    taskAgentClaude.completed?.usage?.promptTokens === 3 &&
      taskAgentClaude.completed?.usage?.completionTokens === 4 &&
      taskAgentClaude.completed?.usage?.totalTokens === 7,
    'agent Claude usage was not merged from stream events',
  )
  assert(
    taskAgentClaudeRequests.length === 1 &&
      taskAgentClaudeRequests[0]?.path === '/v1/messages' &&
      taskAgentClaudeRequests[0]?.authMatches === true &&
      taskAgentClaudeRequests[0]?.claudePayloadMatches === true,
    'agent Claude request did not use the expected endpoint, payload, or x-api-key',
  )
  assert(taskAgentClaude.dismissed?.ok, 'agent Claude task cleanup failed')

  const memoryMigration = await settings.evaluate(async (personaId) => {
    const personas = await window.neoDeskPet.listPersonas()
    const listed = await window.neoDeskPet.listMemory({
      personaId,
      scope: 'persona',
      query: 'legacy searchable',
      limit: 20,
    })
    return { personas, listed }
  }, legacyMemoryPersonaId)
  const memoryMigrationRetrieve = await chat.evaluate(
    async ({ personaId, query }) => window.neoDeskPet.retrieveMemory({ personaId, query, limit: 10, reinforce: false }),
    { personaId: legacyMemoryPersonaId, query: legacyMemoryContent },
  )
  const migratedMemory = memoryMigration.listed.items.find((item) => item.content === legacyMemoryContent)
  assert(
    memoryMigration.personas.some((persona) => persona.id === legacyMemoryPersonaId),
    'legacy memory persona was not preserved during schema migration',
  )
  assert(
    migratedMemory?.updatedAt === legacyMemoryCreatedAt,
    'legacy memory updated_at was not backfilled from created_at',
  )
  assert(
    migratedMemory?.status === 'active' && migratedMemory?.memoryType === 'other' && migratedMemory?.pinned === 0,
    'legacy memory compatibility columns were not initialized with safe defaults',
  )
  assert(memoryMigrationRetrieve.debug?.counts.fts > 0, 'legacy memory was not rebuilt into memory_fts')
  assert(memoryMigrationRetrieve.addon.includes(legacyMemoryContent), 'legacy memory was not returned by FTS retrieval')

  const memoryCrudSeed = await settings.evaluate(async () => {
    const persona = await window.neoDeskPet.createPersona('IPC Memory Persona')
    const updatedPersona = await window.neoDeskPet.updatePersona(persona.id, {
      name: 'IPC Memory Updated',
      captureUser: false,
    })
    const created = await window.neoDeskPet.upsertManualMemory({
      personaId: persona.id,
      scope: 'persona',
      content: 'IPC manual memory',
      source: 'ipc-smoke',
      memoryType: 'semantic',
    })
    return { persona, updatedPersona, created }
  })
  const memoryCrud = await memory.evaluate(async ({ personaId, rowid }) => {
    const updated = await window.neoDeskPet.updateMemory({
      rowid,
      content: 'IPC updated memory',
      reason: 'ipc_smoke',
      source: 'ipc_smoke',
    })
    const versions = await window.neoDeskPet.listMemoryVersions({ rowid, limit: 10 })
    const meta = await window.neoDeskPet.updateMemoryMeta({ rowid, patch: { pinned: 1 } })
    const listed = await window.neoDeskPet.listMemory({
      personaId,
      scope: 'all',
      limit: 50,
    })
    await window.neoDeskPet.deleteMemory({ rowid })
    const afterDelete = await window.neoDeskPet.listMemory({
      personaId,
      scope: 'all',
      limit: 50,
    })
    return { updated, versions, meta, listed, afterDelete }
  }, { personaId: memoryCrudSeed.persona.id, rowid: memoryCrudSeed.created.rowid })
  const memoryPersonaCleanup = await settings.evaluate(async (personaId) => {
    await window.neoDeskPet.deletePersona(personaId)
    const personasAfterDelete = await window.neoDeskPet.listPersonas()
    return { personasAfterDelete }
  }, memoryCrudSeed.persona.id)
  assert(memoryCrudSeed.updatedPersona.name === 'IPC Memory Updated', 'memory persona update failed')
  assert(memoryCrudSeed.updatedPersona.captureUser === false, 'memory persona capture settings were not updated')
  assert(memoryCrud.updated.content === 'IPC updated memory', 'manual memory update failed')
  assert(memoryCrud.versions.length > 0, 'memory update did not create a version')
  assert(memoryCrud.meta.updated === 1, 'memory metadata update failed')
  assert(memoryCrud.listed.items.some((item) => item.rowid === memoryCrudSeed.created.rowid), 'manual memory was not listed')
  assert(!memoryCrud.afterDelete.items.some((item) => item.rowid === memoryCrudSeed.created.rowid), 'manual memory deletion failed')
  assert(
    !memoryPersonaCleanup.personasAfterDelete.some((item) => item.id === memoryCrudSeed.persona.id),
    'memory persona deletion failed',
  )

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
  const restartRecordedRequest = aiRequests.findLast((request) => request.model === 'ipc-smoke-restart')
  assert(restartRecordedRequest?.authMatches, 'AI key was not restored after restart')
  assert(restartRecordedRequest?.path === '/v1/chat/completions', 'AI proxy used an unexpected endpoint after restart')

  const chatPersistenceAfterRestart = await restartedChat.evaluate(async (sessionId) => {
    const loaded = await window.neoDeskPet.getChatSession(sessionId)
    await window.neoDeskPet.deleteChatMessage(sessionId, 'ipc-smoke-user')
    const afterMessageDelete = await window.neoDeskPet.getChatSession(sessionId)
    await window.neoDeskPet.clearChatSession(sessionId)
    const afterClear = await window.neoDeskPet.getChatSession(sessionId)
    const afterSessionDelete = await window.neoDeskPet.deleteChatSession(sessionId)
    return { loaded, afterMessageDelete, afterClear, afterSessionDelete }
  }, chatPersistenceBeforeRestart.sessionId)
  assert(chatPersistenceAfterRestart.loaded.name === 'IPC Smoke Renamed', 'chat session was lost after restart')
  assert(chatPersistenceAfterRestart.loaded.messages.length === 2, 'chat messages were lost after restart')
  assert(
    chatPersistenceAfterRestart.loaded.messages[1]?.content === '结构化更新',
    'updated chat message was lost after restart',
  )
  assert(chatPersistenceAfterRestart.afterMessageDelete.messages.length === 1, 'chat message deletion failed')
  assert(chatPersistenceAfterRestart.afterClear.messages.length === 0, 'chat clear failed')
  assert(
    !chatPersistenceAfterRestart.afterSessionDelete.sessions.some(
      (session) => session.id === chatPersistenceBeforeRestart.sessionId,
    ),
    'chat session deletion failed',
  )

  const taskPersistenceAfterRestart = await restartedChat.evaluate(async (taskId) => {
    const loaded = await window.neoDeskPet.getTask(taskId)
    const listed = await window.neoDeskPet.listTasks()
    const dismissed = await window.neoDeskPet.dismissTask(taskId)
    const afterDismiss = await window.neoDeskPet.listTasks()
    return { loaded, listed, dismissed, afterDismiss }
  }, taskPersistenceBeforeRestart.taskId)
  assert(taskPersistenceAfterRestart.loaded?.status === 'done', 'completed task was lost or changed after restart')
  assert(
    taskPersistenceAfterRestart.listed.items.some((task) => task.id === taskPersistenceBeforeRestart.taskId),
    'completed task was not listed after restart',
  )
  assert(taskPersistenceAfterRestart.dismissed?.ok === true, 'task dismiss failed after restart')
  assert(
    !taskPersistenceAfterRestart.afterDismiss.items.some((task) => task.id === taskPersistenceBeforeRestart.taskId),
    'dismissed task remained in the task list',
  )

  const report = {
    generatedAt: new Date().toISOString(),
    executablePath,
    outputDir,
    urls,
    keys,
    windowSizes: {
      defaults: defaultWindowSizes,
      orbStateRoundTrip,
    },
    settingsNavigation: {
      onCreate: settingsNavigationOnCreate?.trim() ?? '',
      onReuse: settingsNavigationOnReuse?.trim() ?? '',
    },
    chatPersistence: {
      sessionId: chatPersistenceBeforeRestart.sessionId,
      beforeRestart: chatPersistenceBeforeRestart.loaded,
      afterRestart: chatPersistenceAfterRestart.loaded,
      deleteMessage: chatPersistenceAfterRestart.afterMessageDelete.messages.length === 1,
      clear: chatPersistenceAfterRestart.afterClear.messages.length === 0,
      deleteSession: true,
    },
    taskPersistence: {
      taskId: taskPersistenceBeforeRestart.taskId,
      beforeRestart: taskPersistenceBeforeRestart.loaded,
      afterRestart: taskPersistenceAfterRestart.loaded,
      dismiss: taskPersistenceAfterRestart.dismissed?.ok === true,
    },
    taskLifecycle: {
      pausedStepIndex: taskLifecycle.pausedStepIndex,
      whilePausedStepIndex: taskLifecycle.whilePaused?.currentStepIndex,
      completedStatus: taskLifecycle.completed.status,
      completedSteps: taskLifecycle.completed.currentStepIndex,
      canceledStatus: taskLifecycle.afterCancel?.status,
      canceledStepStatus: taskLifecycle.afterCancel?.steps?.[taskLifecycle.afterCancel.currentStepIndex]?.status,
      directStatus: taskLifecycle.directCompleted?.status,
      directToolRun: taskLifecycle.directCompleted?.toolRuns?.[0]?.status,
      mediaStatus: taskLifecycle.mediaCompleted?.status,
      mediaStep: taskLifecycle.mediaCompleted?.steps?.[0]?.status,
      mediaToolRun: taskLifecycle.mediaCompleted?.toolRuns?.find((run) => run.toolName === 'file.read')?.status,
      mediaImage: taskLifecycle.mediaCompleted?.toolRuns
        ?.find((run) => run.toolName === 'file.read')
        ?.imagePaths?.includes(taskMediaImage),
      failedStatus: taskLifecycle.failed?.status,
      failedToolRun: taskLifecycle.failed?.toolRuns?.[0]?.status,
      cleanup: Boolean(
        taskLifecycle.pauseDismissed?.ok &&
          taskLifecycle.cancelDismissed?.ok &&
          taskLifecycle.directDismissed?.ok &&
          taskLifecycle.mediaDismissed?.ok &&
          taskLifecycle.failedDismissed?.ok,
      ),
    },
    taskAgentProtocol: {
      status: taskAgentProtocol.completed?.status,
      output: taskAgentProtocol.completed?.steps[0]?.output,
      toolRuns: taskAgentProtocol.completed?.toolRuns,
      requestCount: taskAgentRequests.length,
      retryStatus: taskAgentRequests[0]?.simulatedStatus,
      resultRoundTrip: taskAgentRequests[2]?.hasAgentToolResult === true,
      cleanup: taskAgentProtocol.dismissed?.ok === true,
    },
    taskMcpDirect: {
      status: taskMcpDirect.completed?.status,
      step: taskMcpDirect.completed?.steps?.[0]?.status,
      toolRun: taskMcpDirect.completed?.toolRuns?.find(
        (run) => run.toolName === 'mcp.mmvector.capture_image',
      ),
      cleanup: taskMcpDirect.dismissed?.ok === true,
    },
    taskAgentMmvector: {
      mcpConnected: taskAgentMmvectorMcp.servers.some(
        (server) => server.id === 'mmvector' && server.status === 'connected',
      ),
      status: taskAgentMmvector.completed?.status,
      output: taskAgentMmvector.completed?.steps[0]?.output,
      toolRuns: taskAgentMmvector.completed?.toolRuns,
      requestCount: taskAgentMmvectorRequests.length,
      resultRoundTrip: taskAgentMmvectorRequests[1]?.hasAgentToolResult === true,
      cleanup: taskAgentMmvector.dismissed?.ok === true,
    },
    taskAgentNative: {
      status: taskAgentNative.completed?.status,
      output: taskAgentNative.completed?.steps[0]?.output,
      toolRuns: taskAgentNative.completed?.toolRuns,
      requestCount: taskAgentNativeRequests.length,
      payloadMatches: taskAgentNativeRequests.every((request) => request.nativePayloadMatches),
      resultRoundTrip: taskAgentNativeRequests[1]?.hasNativeToolResult === true,
      cleanup: taskAgentNative.dismissed?.ok === true,
    },
    taskAgentAutoFallback: {
      status: taskAgentAutoFallback.completed?.status,
      output: taskAgentAutoFallback.completed?.steps[0]?.output,
      toolRuns: taskAgentAutoFallback.completed?.toolRuns,
      requestCount: taskAgentAutoFallbackRequests.length,
      nativeResultRoundTrip: taskAgentAutoFallbackRequests[1]?.hasNativeToolResult === true,
      fallbackStatus: taskAgentAutoFallbackRequests[1]?.simulatedStatus,
      textResultReplay: taskAgentAutoFallbackRequests[2]?.hasAgentToolResult === true,
      visionReplay: taskAgentAutoFallbackRequests.every((request) => request.hasVisionInput === true),
      cleanup: taskAgentAutoFallback.dismissed?.ok === true,
    },
    taskAgentClaude: {
      status: taskAgentClaude.completed?.status,
      output: taskAgentClaude.completed?.steps[0]?.output,
      usage: taskAgentClaude.completed?.usage,
      endpoint: taskAgentClaudeRequests[0]?.path,
      authMatches: taskAgentClaudeRequests[0]?.authMatches,
      payloadMatches: taskAgentClaudeRequests[0]?.claudePayloadMatches,
      cleanup: taskAgentClaude.dismissed?.ok === true,
    },
    memoryCrud: {
      migration: {
        personaPreserved: memoryMigration.personas.some((persona) => persona.id === legacyMemoryPersonaId),
        memoryRowid: migratedMemory?.rowid,
        updatedAt: migratedMemory?.updatedAt,
        status: migratedMemory?.status,
        memoryType: migratedMemory?.memoryType,
        pinned: migratedMemory?.pinned,
        ftsHits: memoryMigrationRetrieve.debug?.counts.fts ?? 0,
      },
      personaId: memoryCrudSeed.persona.id,
      memoryRowid: memoryCrudSeed.created.rowid,
      update: memoryCrud.updated.content === 'IPC updated memory',
      versionCount: memoryCrud.versions.length,
      metadata: memoryCrud.meta,
      deleteMemory: true,
      deletePersona: true,
    },
    ttsProxy: {
      json: ttsProxy.json.ok,
      arrayBufferBytes: ttsProxy.audio.arrayBuffer.length,
      streamBytes: ttsProxy.stream.bytes.length,
      deniedPath: ttsProxy.deniedPath,
      requests: ttsRequests,
      chatToPetRelay: ttsEnqueueRelay,
      petToChatRelay: ttsSegmentRelay,
    },
    presentationRelay: {
      ...presentationRelay,
      asrTranscript: asrTranscriptRelay,
      capabilitiesAccepted: true,
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
