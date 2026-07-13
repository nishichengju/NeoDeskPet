import type { WindowType } from './types'

export type IpcWindowPermission = readonly WindowType[]

const ALL_WINDOWS = ['pet', 'chat', 'settings', 'memory', 'orb', 'orb-menu'] as const satisfies IpcWindowPermission

export const IPC_CHANNEL_PERMISSIONS = {
  'debug:getPath': ['settings'],
  'debug:clear': ['settings'],
  'debug:append': ['pet', 'chat'],

  'settings:get': ALL_WINDOWS,
  'settings:consumeNavigation': ['settings'],
  'settings:setSecret': ['settings'],
  'settings:setAlwaysOnTop': ['settings'],
  'settings:setClickThrough': ['settings'],
  'settings:setActivePersonaId': ['settings'],
  'settings:setMemorySettings': ['chat', 'settings', 'memory'],
  'settings:setMemoryConsoleSettings': ['memory'],
  'settings:setPetScale': ['settings'],
  'settings:setPetOpacity': ['settings'],
  'settings:setLive2dModel': ['settings'],
  'settings:setLive2dMouseTrackingEnabled': ['settings'],
  'settings:setLive2dIdleSwayEnabled': ['settings'],
  'settings:setAISettings': ['settings'],
  'settings:setNovelAISettings': ['settings'],
  'settings:saveAIProfile': ['settings'],
  'settings:deleteAIProfile': ['settings'],
  'settings:applyAIProfile': ['settings'],
  'ai:listModels': ['settings'],
  'ai:httpRequest': ['chat', 'memory', 'orb'],
  'ai:httpStreamStart': ['chat', 'memory', 'orb'],
  'ai:httpStreamCancel': ['chat', 'memory', 'orb'],
  'settings:setBubbleSettings': ['pet', 'settings'],
  'settings:setTaskPanelSettings': ['settings'],
  'settings:setOrchestratorSettings': ['chat', 'settings'],
  'settings:setToolSettings': ['settings'],
  'settings:setMcpSettings': ['settings'],
  'mcp:getState': ['chat', 'settings'],
  'settings:setChatProfile': ['chat', 'settings', 'orb'],
  'settings:setChatUiSettings': ['chat', 'settings'],
  'settings:setWorldBookSettings': ['settings'],
  'contextUsage:set': ['chat'],
  'contextUsage:get': ['pet', 'chat'],
  'settings:setTtsSettings': ['settings'],
  'settings:setAsrSettings': ['settings'],
  'models:scan': ['pet', 'settings'],

  'chat:list': ['chat', 'memory', 'orb'],
  'chat:get': ['chat', 'memory', 'orb'],
  'chat:create': ['chat', 'orb'],
  'chat:setCurrent': ['chat', 'orb'],
  'chat:rename': ['chat'],
  'chat:delete': ['chat', 'orb'],
  'chat:clear': ['chat'],
  'chat:setMessages': ['chat', 'orb'],
  'chat:addMessage': ['chat', 'orb'],
  'chat:updateMessage': ['chat', 'orb'],
  'chat:updateMessageRecord': ['chat', 'orb'],
  'chat:deleteMessage': ['chat'],
  'chat:setAutoExtractCursor': ['chat'],
  'chat:setAutoExtractMeta': ['chat', 'memory'],
  'chat:saveAttachment': ['chat', 'orb'],
  'chat:readAttachmentDataUrl': ['chat', 'orb'],
  'chat:getAttachmentUrl': ['chat', 'orb'],

  'task:list': ['pet', 'chat', 'settings', 'orb'],
  'task:get': ['pet', 'chat', 'orb'],
  'task:updateToolRunImages': ['chat'],
  'task:create': ['chat', 'orb'],
  'task:pause': ['pet', 'chat', 'orb'],
  'task:resume': ['pet', 'chat', 'orb'],
  'task:cancel': ['pet', 'chat', 'orb'],
  'task:dismiss': ['pet', 'chat', 'orb'],

  'memory:listPersonas': ['chat', 'settings', 'memory', 'orb'],
  'memory:getPersona': ['chat', 'settings', 'memory', 'orb'],
  'memory:createPersona': ['settings'],
  'memory:updatePersona': ['chat', 'settings', 'memory'],
  'memory:deletePersona': ['settings'],
  'memory:retrieve': ['chat', 'orb'],
  'memory:list': ['settings', 'memory'],
  'memory:upsertManual': ['chat', 'settings', 'memory'],
  'memory:update': ['memory'],
  'memory:updateMeta': ['memory'],
  'memory:updateManyMeta': ['memory'],
  'memory:updateByFilterMeta': ['memory'],
  'memory:listVersions': ['memory'],
  'memory:rollbackVersion': ['memory'],
  'memory:listConflicts': ['memory'],
  'memory:resolveConflict': ['memory'],
  'memory:delete': ['settings', 'memory'],
  'memory:deleteMany': ['memory'],
  'memory:deleteByFilter': ['memory'],

  'tts:listOptions': ['settings'],
  'tts:httpGetJson': ['pet', 'settings'],
  'tts:httpRequestArrayBuffer': ['pet', 'settings'],
  'tts:httpStreamStart': ['pet', 'settings'],
  'tts:httpStreamCancel': ['pet', 'settings'],
  'live2d:triggerExpression': ['pet', 'chat', 'settings'],
  'live2d:triggerMotion': ['pet', 'chat', 'settings'],
  'live2d:capabilities': ['pet'],
  'bubble:sendMessage': ['chat'],
  'bubble:preview': ['chat'],
  'asr:reportTranscript': ['pet'],
  'asr:takeTranscript': ['chat'],
  'asr:transcriptReady': ['chat'],
  'asr:composePreviewSync': ['chat'],
  'tts:enqueue': ['chat'],
  'tts:finalize': ['chat'],
  'tts:stopAll': ['chat'],
  'tts:segmentStarted': ['pet'],
  'tts:utteranceEnded': ['pet'],
  'tts:utteranceFailed': ['pet'],

  'window:openChat': ['pet', 'orb'],
  'window:openSettings': ['pet', 'chat', 'memory', 'orb', 'orb-menu'],
  'window:openMemory': ['chat', 'settings'],
  'window:setDisplayMode': ['pet', 'orb', 'orb-menu'],
  'window:hideAll': ['pet', 'orb', 'orb-menu'],
  'window:closeCurrent': ['chat', 'settings', 'memory', 'orb', 'orb-menu'],
  'app:quit': ['pet', 'orb', 'orb-menu'],
  'orb:getUiState': ['orb'],
  'orb:setUiState': ['orb'],
  'orb:toggleUiState': ['orb'],
  'orb:setOverlayBounds': ['orb'],
  'orb:clearOverlayBounds': ['orb'],
  'orb:showContextMenu': ['orb'],
  'window:startDrag': ['pet', 'orb'],
  'window:dragMove': ['pet', 'orb'],
  'window:stopDrag': ['pet', 'orb'],
  'pet:showContextMenu': ['pet'],
  'pet:setOverlayHover': ['pet'],
  'pet:setModelHover': ['pet'],
  'window:setIgnoreMouseEvents': ['pet'],
} as const satisfies Record<string, IpcWindowPermission>

export type IpcChannel = keyof typeof IPC_CHANNEL_PERMISSIONS

export type IpcSecurityFailureReason =
  | 'unknown-channel'
  | 'unknown-sender'
  | 'subframe'
  | 'untrusted-frame-url'
  | 'untrusted-webcontents-url'
  | 'window-not-allowed'

export type IpcAuthorizationInput = {
  channel: string
  senderWindowType: WindowType | null | undefined
  allowed: IpcWindowPermission | null | undefined
  isMainFrame: boolean
  isFrameUrlTrusted: boolean
  isWebContentsUrlTrusted: boolean
}

export type IpcAuthorizationResult =
  | { allowed: true; windowType: WindowType }
  | { allowed: false; reason: IpcSecurityFailureReason }

export class IpcSecurityError extends Error {
  readonly code = 'ERR_NEODESKPET_IPC_FORBIDDEN'
  readonly channel: string
  readonly senderWindowType: WindowType | null
  readonly reason: IpcSecurityFailureReason

  constructor(channel: string, senderWindowType: WindowType | null | undefined, reason: IpcSecurityFailureReason) {
    const sender = senderWindowType ?? 'unknown'
    super(`IPC request denied: channel=${channel}; sender=${sender}; reason=${reason}`)
    this.name = 'IpcSecurityError'
    this.channel = channel
    this.senderWindowType = senderWindowType ?? null
    this.reason = reason
  }
}

export function getIpcWindowPermission(channel: string): IpcWindowPermission | null {
  return Object.prototype.hasOwnProperty.call(IPC_CHANNEL_PERMISSIONS, channel)
    ? IPC_CHANNEL_PERMISSIONS[channel as IpcChannel]
    : null
}

export function isIpcWindowAllowed(senderWindowType: WindowType | null | undefined, allowed: IpcWindowPermission): boolean {
  return senderWindowType != null && allowed.includes(senderWindowType)
}

export function authorizeIpcSender(input: IpcAuthorizationInput): IpcAuthorizationResult {
  if (!input.allowed) return { allowed: false, reason: 'unknown-channel' }
  if (!input.senderWindowType) return { allowed: false, reason: 'unknown-sender' }
  if (!input.isMainFrame) return { allowed: false, reason: 'subframe' }
  if (!input.isFrameUrlTrusted) return { allowed: false, reason: 'untrusted-frame-url' }
  if (!input.isWebContentsUrlTrusted) return { allowed: false, reason: 'untrusted-webcontents-url' }
  if (!isIpcWindowAllowed(input.senderWindowType, input.allowed)) return { allowed: false, reason: 'window-not-allowed' }
  return { allowed: true, windowType: input.senderWindowType }
}

export function assertTrustedIpcSender(input: IpcAuthorizationInput): asserts input is IpcAuthorizationInput & {
  senderWindowType: WindowType
  allowed: IpcWindowPermission
} {
  const result = authorizeIpcSender(input)
  if (result.allowed) return
  throw new IpcSecurityError(input.channel, input.senderWindowType, result.reason)
}

export function assertIpcWindowAllowed(
  channel: string,
  senderWindowType: WindowType | null | undefined,
  allowed: IpcWindowPermission,
): asserts senderWindowType is WindowType {
  if (isIpcWindowAllowed(senderWindowType, allowed)) return
  throw new IpcSecurityError(channel, senderWindowType, 'window-not-allowed')
}

export function isTrustedApplicationUrl(actualRaw: string, expectedRaw: string): boolean {
  try {
    const actual = new URL(actualRaw)
    const expected = new URL(expectedRaw)
    return (
      actual.protocol === expected.protocol &&
      actual.username === expected.username &&
      actual.password === expected.password &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      actual.hash === expected.hash
    )
  } catch {
    return false
  }
}
