import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getSettings, setSettings } from './store'
import { createTray } from './tray'
import { WindowManager } from './windowManager'
import { scanLive2dModels } from './modelScanner'
import { listTtsOptions } from './ttsOptions'
import {
  addChatMessage,
  clearChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  renameChatSession,
  setChatSessionAutoExtractCursor,
  setChatSessionAutoExtractMeta,
  setChatMessages,
  setCurrentChatSession,
  updateChatMessage,
} from './chatStore'
import type {
  AISettings,
  AsrSettings,
  BubbleSettings,
  ChatMessageRecord,
  ChatProfile,
  ChatUiSettings,
  MemoryDeleteArgs,
  MemoryDeleteByFilterArgs,
  MemoryDeleteManyArgs,
  MemoryListArgs,
  MemoryListConflictsArgs,
  MemoryListConflictsResult,
  MemoryListResult,
  MemoryListVersionsArgs,
  MemoryRecord,
  MemoryResolveConflictArgs,
  MemoryResolveConflictResult,
  MemoryRollbackVersionArgs,
  MemoryRetrieveArgs,
  MemoryRetrieveResult,
  MemoryConsoleSettings,
  MemorySettings,
  MemoryUpdateArgs,
  MemoryUpdateByFilterMetaArgs,
  MemoryUpdateManyMetaArgs,
  MemoryUpdateMetaArgs,
  MemoryUpdateMetaResult,
  MemoryUpsertManualArgs,
  MemoryVersionRecord,
  Persona,
  PersonaSummary,
  TtsSettings,
} from './types'
import { MemoryService } from './memoryService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const windowManager = new WindowManager({
  rendererDevUrl: VITE_DEV_SERVER_URL,
  rendererDistDir: RENDERER_DIST,
  mainDistDir: MAIN_DIST,
})

let memoryService: MemoryService | null = null

function broadcastSettingsChanged() {
  const settings = getSettings()
  for (const win of windowManager.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('settings:changed', settings)
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:setAlwaysOnTop', (_event, value: boolean) => {
    windowManager.setAlwaysOnTop(value)
    broadcastSettingsChanged()
    return getSettings()
  })
  ipcMain.handle('settings:setClickThrough', (_event, value: boolean) => {
    windowManager.setClickThrough(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setActivePersonaId', (_event, personaId: string) => {
    setSettings({ activePersonaId: personaId })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setMemorySettings', (_event, memory: Partial<MemorySettings>) => {
    const current = getSettings()
    setSettings({ memory: { ...current.memory, ...memory } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setMemoryConsoleSettings', (_event, patch: Partial<MemoryConsoleSettings>) => {
    const current = getSettings()
    setSettings({ memoryConsole: { ...current.memoryConsole, ...patch } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setPetScale', (_event, value: number) => {
    setSettings({ petScale: value })
    windowManager.resizePetWindowForScale(value)
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setPetOpacity', (_event, value: number) => {
    setSettings({ petOpacity: value })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setLive2dModel', (_event, modelId: string, modelFile: string) => {
    setSettings({ live2dModelId: modelId, live2dModelFile: modelFile })
    broadcastSettingsChanged()
    return getSettings()
  })

  // AI settings handlers
  ipcMain.handle('settings:setAISettings', (_event, aiSettings: Partial<AISettings>) => {
    const current = getSettings()
    setSettings({ ai: { ...current.ai, ...aiSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setBubbleSettings', (_event, bubbleSettings: Partial<BubbleSettings>) => {
    const current = getSettings()
    setSettings({ bubble: { ...current.bubble, ...bubbleSettings } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setChatProfile', (_event, chatProfile: Partial<ChatProfile>) => {
    const current = getSettings()
    setSettings({ chatProfile: { ...current.chatProfile, ...chatProfile } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setChatUiSettings', (_event, chatUi: Partial<ChatUiSettings>) => {
    const current = getSettings()
    setSettings({ chatUi: { ...current.chatUi, ...chatUi } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setTtsSettings', (_event, tts: Partial<TtsSettings>) => {
    const current = getSettings()
    setSettings({ tts: { ...current.tts, ...tts } })
    broadcastSettingsChanged()
    return getSettings()
  })

  ipcMain.handle('settings:setAsrSettings', (_event, asr: Partial<AsrSettings>) => {
    const current = getSettings()
    setSettings({ asr: { ...current.asr, ...asr } })
    broadcastSettingsChanged()
    return getSettings()
  })

  // Model scanner - scan live2d directory for available models
  ipcMain.handle('models:scan', () => {
    return scanLive2dModels()
  })

  // Chat persistence
  ipcMain.handle('chat:list', () => listChatSessions())
  ipcMain.handle('chat:get', (_event, sessionId?: string) => getChatSession(sessionId))
  ipcMain.handle('chat:create', (_event, name?: string, personaId?: string) => createChatSession(name, personaId))
  ipcMain.handle('chat:setCurrent', (_event, sessionId: string) => setCurrentChatSession(sessionId))
  ipcMain.handle('chat:rename', (_event, sessionId: string, name: string) => renameChatSession(sessionId, name))
  ipcMain.handle('chat:delete', (_event, sessionId: string) => deleteChatSession(sessionId))
  ipcMain.handle('chat:clear', (_event, sessionId: string) => clearChatSession(sessionId))
  ipcMain.handle('chat:setMessages', (_event, sessionId: string, messages: ChatMessageRecord[]) =>
    setChatMessages(sessionId, messages),
  )
  ipcMain.handle('chat:addMessage', (_event, sessionId: string, message: ChatMessageRecord) => {
    const session = addChatMessage(sessionId, message)
    try {
      const memEnabled = getSettings().memory.enabled
      if (!memEnabled) return session
      const personaId = session.personaId || 'default'
      memoryService?.ingestChatMessage({
        personaId,
        sessionId,
        messageId: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })
    } catch (_) {
      /* ignore */
    }
    return session
  })
  ipcMain.handle('chat:updateMessage', (_event, sessionId: string, messageId: string, content: string) => {
    const session = updateChatMessage(sessionId, messageId, content)
    try {
      const memEnabled = getSettings().memory.enabled
      if (!memEnabled) return session
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg) return session
      const personaId = session.personaId || 'default'
      memoryService?.ingestChatMessage({
        personaId,
        sessionId,
        messageId: msg.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
      })
    } catch (_) {
      /* ignore */
    }
    return session
  })
  ipcMain.handle('chat:deleteMessage', (_event, sessionId: string, messageId: string) => deleteChatMessage(sessionId, messageId))
  ipcMain.handle('chat:setAutoExtractCursor', (_event, sessionId: string, cursor: number) =>
    setChatSessionAutoExtractCursor(sessionId, cursor),
  )
  ipcMain.handle('chat:setAutoExtractMeta', (_event, sessionId: string, patch: unknown) =>
    setChatSessionAutoExtractMeta(sessionId, patch),
  )

  // Long-term memory / personas
  ipcMain.handle('memory:listPersonas', (): PersonaSummary[] => memoryService?.listPersonas() ?? [])
  ipcMain.handle('memory:getPersona', (_event, personaId: string): Persona | null => memoryService?.getPersona(personaId) ?? null)
  ipcMain.handle('memory:createPersona', (_event, name: string): Persona => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.createPersona(name)
  })
  ipcMain.handle(
    'memory:updatePersona',
    (
      _event,
      personaId: string,
      patch: {
        name?: string
        prompt?: string
        captureEnabled?: boolean
        captureUser?: boolean
        captureAssistant?: boolean
        retrieveEnabled?: boolean
      },
    ): Persona => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updatePersona(personaId, patch)
    },
  )
  ipcMain.handle('memory:deletePersona', (_event, personaId: string): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    memoryService.deletePersona(personaId)
    return { ok: true }
  })
  ipcMain.handle('memory:retrieve', async (_event, args: MemoryRetrieveArgs): Promise<MemoryRetrieveResult> => {
    if (!memoryService) return { addon: '' }
    const settings = getSettings()
    if (!settings.memory.enabled) return { addon: '' }
    return memoryService.retrieveContext(args, settings.memory, settings.ai)
  })
  ipcMain.handle('memory:list', (_event, args: MemoryListArgs): MemoryListResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemory(args)
  })
  ipcMain.handle('memory:upsertManual', (_event, args: MemoryUpsertManualArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.upsertManualMemory(args)
  })
  ipcMain.handle('memory:update', (_event, args: MemoryUpdateArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemory(args)
  })
  ipcMain.handle('memory:updateMeta', (_event, args: MemoryUpdateMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryMeta(args)
  })
  ipcMain.handle('memory:updateManyMeta', (_event, args: MemoryUpdateManyMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateManyMemoryMeta(args)
  })
  ipcMain.handle('memory:updateByFilterMeta', (_event, args: MemoryUpdateByFilterMetaArgs): MemoryUpdateMetaResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.updateMemoryByFilterMeta(args)
  })
  ipcMain.handle('memory:listVersions', (_event, args: MemoryListVersionsArgs): MemoryVersionRecord[] => {
    if (!memoryService) return []
    return memoryService.listMemoryVersions(args)
  })
  ipcMain.handle('memory:rollbackVersion', (_event, args: MemoryRollbackVersionArgs): MemoryRecord => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.rollbackMemoryVersion(args)
  })
  ipcMain.handle('memory:listConflicts', (_event, args: MemoryListConflictsArgs): MemoryListConflictsResult => {
    if (!memoryService) return { total: 0, items: [] }
    return memoryService.listMemoryConflicts(args)
  })
  ipcMain.handle('memory:resolveConflict', (_event, args: MemoryResolveConflictArgs): MemoryResolveConflictResult => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.resolveMemoryConflict(args)
  })
  ipcMain.handle('memory:delete', (_event, args: MemoryDeleteArgs): { ok: true } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemory(args)
  })
  ipcMain.handle('memory:deleteMany', (_event, args: MemoryDeleteManyArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteManyMemory(args)
  })
  ipcMain.handle('memory:deleteByFilter', (_event, args: MemoryDeleteByFilterArgs): { deleted: number } => {
    if (!memoryService) throw new Error('Memory service not ready')
    return memoryService.deleteMemoryByFilter(args)
  })

  // TTS options (scan local GPT-SoVITS directory)
  ipcMain.handle('tts:listOptions', () => {
    return listTtsOptions(process.env.APP_ROOT ?? process.cwd())
  })

  // Live2D expression/motion triggers - broadcast to pet window
  ipcMain.on('live2d:triggerExpression', (_event, expressionName: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:expression', expressionName)
    }
  })

  ipcMain.on('live2d:triggerMotion', (_event, motionGroup: string, index: number) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('live2d:motion', motionGroup, index)
    }
  })

  // Bubble message - forward from chat window to pet window
  ipcMain.on('bubble:sendMessage', (_event, message: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('bubble:message', message)
    }
  })

  // TTS segmented sync: forward utterance segments to pet window
  ipcMain.on('tts:enqueue', (_event, payload: unknown) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:enqueue', payload)
    }
  })

  ipcMain.on('tts:finalize', (_event, utteranceId: string) => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:finalize', utteranceId)
    }
  })

  ipcMain.on('tts:stopAll', () => {
    const petWin = windowManager.getPetWindow()
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('tts:stopAll')
    }
  })

  // Pet -> Chat: segment started / ended / failed
  ipcMain.on('tts:segmentStarted', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:segmentStarted', payload)
    }
  })

  ipcMain.on('tts:utteranceEnded', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceEnded', payload)
    }
  })

  ipcMain.on('tts:utteranceFailed', (_event, payload: unknown) => {
    const chatWin = windowManager.getChatWindow()
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('tts:utteranceFailed', payload)
    }
  })

  ipcMain.handle('window:openChat', () => {
    windowManager.ensureChatWindow()
  })
  ipcMain.handle('window:openSettings', () => {
    windowManager.ensureSettingsWindow()
  })
  ipcMain.handle('window:openMemory', () => {
    windowManager.ensureMemoryWindow()
  })
  ipcMain.handle('window:hideAll', () => {
    windowManager.hideAll()
  })

  // Close current window (not all windows)
  ipcMain.handle('window:closeCurrent', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })

  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  // Window drag support - trigger native window move
  ipcMain.on('window:startDrag', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      const petWin = windowManager.getPetWindow()
      if (petWin && petWin.id === win.id) {
        windowManager.setPetDragging(true)
      }

      // Get current mouse position relative to window
      const mousePos = screen.getCursorScreenPoint()
      const winBounds = win.getBounds()

      // Calculate offset from window origin
      const offsetX = mousePos.x - winBounds.x
      const offsetY = mousePos.y - winBounds.y

      // Track mouse movement
      const onMouseMove = () => {
        if (win.isDestroyed()) return
        const newMousePos = screen.getCursorScreenPoint()
        win.setPosition(newMousePos.x - offsetX, newMousePos.y - offsetY)
      }

      // Use a polling approach for smooth dragging
      const interval = setInterval(onMouseMove, 16) // ~60fps

      // Stop dragging on mouse up
      const stopDrag = () => {
        clearInterval(interval)
        const petWin = windowManager.getPetWindow()
        if (petWin && petWin.id === win.id) {
          windowManager.setPetDragging(false)
        }
      }

      // Listen for mouse up via IPC
      ipcMain.once('window:stopDrag', stopDrag)

      // Also stop after a timeout as fallback
      setTimeout(() => {
        clearInterval(interval)
        ipcMain.removeListener('window:stopDrag', stopDrag)
        const petWin = windowManager.getPetWindow()
        if (petWin && petWin.id === win.id) {
          windowManager.setPetDragging(false)
        }
      }, 30000)
    }
  })

  ipcMain.on('window:stopDrag', () => {
    windowManager.setPetDragging(false)
  })

  // Pet window context menu
  ipcMain.on('pet:showContextMenu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return

    const settings = getSettings()
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: '打开聊天',
        click: () => windowManager.ensureChatWindow(),
      },
      {
        label: '设置',
        click: () => windowManager.ensureSettingsWindow(),
      },
      { type: 'separator' },
      {
        label: '置顶显示',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: () => {
          windowManager.setAlwaysOnTop(!settings.alwaysOnTop)
          broadcastSettingsChanged()
        },
      },
      {
        label: 'TTS 语音播报',
        type: 'checkbox',
        checked: settings.tts?.enabled ?? false,
        click: () => {
          const current = getSettings()
          setSettings({ tts: { ...current.tts, enabled: !current.tts.enabled } })
          broadcastSettingsChanged()
        },
      },
      {
        label: '语音识别（ASR）',
        type: 'checkbox',
        checked: settings.asr?.enabled ?? false,
        click: () => {
          const current = getSettings()
          setSettings({ asr: { ...current.asr, enabled: !current.asr.enabled } })
          broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      {
        label: '隐藏宠物',
        click: () => windowManager.hideAll(),
      },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]

    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win })
  })

  // Dynamic mouse events ignore for transparent click-through
  ipcMain.on('window:setIgnoreMouseEvents', (event, ignore: boolean, forward: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(ignore, { forward })
  })
}

app.on('second-instance', () => {
  windowManager.showPet()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.whenReady().then(() => {
  try {
    memoryService = new MemoryService(app.getPath('userData'))
  } catch (err) {
    console.error('[Memory] Failed to initialize memory service:', err)
    memoryService = null
  }

  const runMemoryMaintenance = () => {
    try {
      if (!memoryService) return
      if (!getSettings().memory.enabled) return
      const res = memoryService.runRetentionMaintenance()
      if (res.updated > 0 || res.archived > 0) {
        console.info(`[Memory] Maintenance: scanned=${res.scanned} updated=${res.updated} archived=${res.archived}`)
      }
    } catch (err) {
      console.error('[Memory] Maintenance failed:', err)
    }
  }

  runMemoryMaintenance()
  const maintenanceTimer = setInterval(runMemoryMaintenance, 6 * 60 * 60_000)
  ;(maintenanceTimer as unknown as { unref?: () => void }).unref?.()

  // M5: Tag/向量索引维护（小批量后台执行，避免阻塞聊天）
  let tagMaintRunning = false
  const runTagMaintenance = () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if ((settings.memory.tagEnabled ?? true) === false) return
      if (tagMaintRunning) return
      tagMaintRunning = true
      const res = memoryService.runTagMaintenance(settings.memory, { batchSize: 80 })
      if (res.updated > 0) {
        console.info(`[Memory] TagIndex: scanned=${res.scanned} updated=${res.updated}`)
      }
    } catch (err) {
      console.error('[Memory] TagIndex failed:', err)
    } finally {
      tagMaintRunning = false
    }
  }

  let vectorMaintRunning = false
  const runVectorMaintenance = async () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if (!(settings.memory.vectorEnabled ?? false)) return
      if (vectorMaintRunning) return
      vectorMaintRunning = true
      const res = await memoryService.runVectorEmbeddingMaintenance(settings.memory, settings.ai, { batchSize: 8 })
      if (res.embedded > 0 || res.skipped > 0 || res.error) {
        console.info(
          `[Memory] VectorIndex: scanned=${res.scanned} embedded=${res.embedded} skipped=${res.skipped}${
            res.error ? ` error=${res.error}` : ''
          }`,
        )
      }
    } catch (err) {
      console.error('[Memory] VectorIndex failed:', err)
    } finally {
      vectorMaintRunning = false
    }
  }

  runTagMaintenance()
  void runVectorMaintenance()
  const tagTimer = setInterval(runTagMaintenance, 5_000)
  const vecTimer = setInterval(() => void runVectorMaintenance(), 5_000)
  ;(tagTimer as unknown as { unref?: () => void }).unref?.()
  ;(vecTimer as unknown as { unref?: () => void }).unref?.()

  let kgMaintRunning = false
  const runKgMaintenance = async () => {
    try {
      if (!memoryService) return
      const settings = getSettings()
      if (!settings.memory.enabled) return
      if (!(settings.memory.kgEnabled ?? false)) return
      if (kgMaintRunning) return
      kgMaintRunning = true
      const res = await memoryService.runKgMaintenance(settings.memory, settings.ai, { batchSize: 2 })
      if (res.extracted > 0 || res.error) {
        console.info(
          `[Memory] KGIndex: scanned=${res.scanned} extracted=${res.extracted} skipped=${res.skipped}${res.error ? ` error=${res.error}` : ''}`,
        )
      }
    } catch (err) {
      console.error('[Memory] KGIndex failed:', err)
    } finally {
      kgMaintRunning = false
    }
  }

  void runKgMaintenance()
  const kgTimer = setInterval(() => void runKgMaintenance(), 7_000)
  ;(kgTimer as unknown as { unref?: () => void }).unref?.()

  registerIpc()

  windowManager.ensurePetWindow()
  createTray(windowManager)

  globalShortcut.register('CommandOrControl+Alt+C', () => {
    windowManager.ensureChatWindow()
  })

  globalShortcut.register('CommandOrControl+Alt+P', () => {
    const { clickThrough } = getSettings()
    windowManager.setClickThrough(!clickThrough)
    broadcastSettingsChanged()
  })

  broadcastSettingsChanged()
})
