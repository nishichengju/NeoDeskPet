import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { AsrSettings } from '../types'
import type { IpcHandle, IpcOn } from './registration'

export type Live2dCapabilitiesResult = { ok: true; value: unknown } | { ok: false; error: string }

export type PresentationIpcWindowManager = {
  getPetWindow: () => BrowserWindow | null
  getChatWindow: () => BrowserWindow | null
  ensureChatWindow: (opts?: { show?: boolean; focus?: boolean }) => BrowserWindow
}

export type PresentationIpcDependencies = {
  handle: IpcHandle
  onIpc: IpcOn
  windowManager: PresentationIpcWindowManager
  getSettings: () => { asr: AsrSettings }
  setLive2dCapabilities: (payload: unknown) => Live2dCapabilitiesResult
  warn?: (...args: unknown[]) => void
}

export class PresentationIpcService {
  private pendingAsrTranscript: string[] = []
  private asrTranscriptReadyWebContentsId: number | null = null

  constructor(private readonly deps: PresentationIpcDependencies) {}

  register(): void {
    const { handle, onIpc } = this.deps

    onIpc('live2d:triggerExpression', (_event, expressionName: string) => {
      this.sendToPet('live2d:expression', expressionName)
    })
    onIpc('live2d:triggerMotion', (_event, motionGroup: string, index: number) => {
      this.sendToPet('live2d:motion', motionGroup, index)
    })
    onIpc('live2d:capabilities', (_event, payload: unknown) => {
      const result = this.deps.setLive2dCapabilities(payload)
      if (!result.ok) (this.deps.warn ?? console.warn)('[Live2D] capabilities report rejected:', result.error)
    })

    onIpc('bubble:sendMessage', (_event, message: string) => {
      this.sendToPet('bubble:message', message)
    })
    onIpc('bubble:preview', (_event, payload: unknown) => {
      const object = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
      const text = typeof object.text === 'string' ? object.text : ''
      const autoHideDelay = typeof object.autoHideDelay === 'number' && Number.isFinite(object.autoHideDelay)
        ? Math.trunc(object.autoHideDelay)
        : undefined
      this.sendToPet('bubble:preview', {
        ...(text ? { text } : {}),
        ...(object.clear === true ? { clear: true } : {}),
        ...(object.placeholder === true ? { placeholder: true } : {}),
        ...(object.pinPrevious === true ? { pinPrevious: true } : {}),
        ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
      })
    })

    onIpc('asr:reportTranscript', (_event, text: string) => this.reportAsrTranscript(text))
    handle('asr:takeTranscript', () => {
      const text = this.pendingAsrTranscript.join(' ').trim()
      this.pendingAsrTranscript = []
      return text
    })
    onIpc('asr:transcriptReady', (event) => this.markAsrTranscriptReady(event))
    onIpc('asr:composePreviewSync', (_event, payload: unknown) => {
      const object = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      this.sendToPet('asr:composePreviewSync', {
        baseText: typeof object.baseText === 'string' ? object.baseText : '',
        clearFinals: object.clearFinals === true,
      })
    })
  }

  private reportAsrTranscript(text: string): void {
    const cleaned = String(text ?? '').trim()
    if (!cleaned) return

    const asr = this.deps.getSettings().asr
    const autoSend = Boolean(asr?.enabled && asr?.autoSend)
    let chatWindow = this.deps.windowManager.getChatWindow()
    if (autoSend && !chatWindow) {
      chatWindow = this.deps.windowManager.ensureChatWindow({ show: false, focus: false })
    }

    const chatWebContents = chatWindow && !chatWindow.isDestroyed() ? chatWindow.webContents : null
    if (chatWebContents?.isLoading()) this.asrTranscriptReadyWebContentsId = null

    if (
      chatWindow &&
      !chatWindow.isDestroyed() &&
      chatWebContents &&
      !chatWebContents.isLoading() &&
      this.asrTranscriptReadyWebContentsId === chatWebContents.id
    ) {
      chatWebContents.send('asr:transcript', cleaned)
      return
    }
    this.pendingAsrTranscript.push(cleaned)
  }

  private markAsrTranscriptReady(event: IpcMainEvent): void {
    const chatWindow = this.deps.windowManager.getChatWindow()
    if (!chatWindow || chatWindow.isDestroyed()) return
    if (event.sender.id !== chatWindow.webContents.id) return
    this.asrTranscriptReadyWebContentsId = event.sender.id
  }

  private sendToPet(channel: string, ...args: unknown[]): void {
    const petWindow = this.deps.windowManager.getPetWindow()
    if (!petWindow || petWindow.isDestroyed()) return
    petWindow.webContents.send(channel, ...args)
  }
}
