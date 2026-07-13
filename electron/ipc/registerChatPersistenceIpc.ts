import type { IpcHandle } from './registration'
import type {
  AISettings,
  ChatMessageRecord,
  ChatSession,
  ChatSessionSummary,
  MemorySettings,
  Persona,
} from '../types'
import type { MemoryIngestChatMessageArgs } from '../memoryService'

export type ChatStoreOperations = {
  listChatSessions: () => { sessions: ChatSessionSummary[]; currentSessionId: string }
  getChatSession: (sessionId?: string) => ChatSession
  createChatSession: (name?: string, personaId?: string) => ChatSession
  setCurrentChatSession: (sessionId: string) => { currentSessionId: string }
  renameChatSession: (sessionId: string, name: string) => ChatSessionSummary
  deleteChatSession: (sessionId: string) => { sessions: ChatSessionSummary[]; currentSessionId: string }
  clearChatSession: (sessionId: string) => ChatSession
  setChatMessages: (sessionId: string, messages: ChatMessageRecord[]) => ChatSession
  addChatMessage: (sessionId: string, message: ChatMessageRecord) => ChatSession
  updateChatMessage: (sessionId: string, messageId: string, content: string) => ChatSession
  updateChatMessageRecord: (sessionId: string, messageId: string, patch: unknown) => ChatSession
  deleteChatMessage: (sessionId: string, messageId: string) => ChatSession
  setChatSessionAutoExtractCursor: (sessionId: string, cursor: number) => ChatSession
  setChatSessionAutoExtractMeta: (sessionId: string, patch: unknown) => ChatSession
}

type ChatMemoryService = {
  getPersona: (personaId: string) => Persona | null
  ingestChatMessage: (
    args: MemoryIngestChatMessageArgs,
    memorySettings: MemorySettings | undefined,
    aiSettings: AISettings,
  ) => Promise<void>
}

export type ChatPersistenceIpcDependencies = {
  handle: IpcHandle
  chatStore: ChatStoreOperations
  getSettings: () => { memory: MemorySettings; ai: AISettings }
  getMemoryService: () => ChatMemoryService | null
}

function findPreviousUserMessage(session: ChatSession, assistantMessageId: string): ChatMessageRecord | null {
  const index = session.messages.findIndex((message) => message.id === assistantMessageId)
  for (let cursor = (index >= 0 ? index : session.messages.length) - 1; cursor >= 0; cursor -= 1) {
    const message = session.messages[cursor]
    if (message.role === 'user') return message
  }
  return null
}

function enqueueAssistantTurnMemory(
  deps: ChatPersistenceIpcDependencies,
  sessionId: string,
  session: ChatSession,
  message: ChatMessageRecord | undefined,
): void {
  try {
    const initialSettings = deps.getSettings()
    if (!initialSettings.memory.enabled || message?.role !== 'assistant') return

    const personaId = session.personaId || 'default'
    const memoryService = deps.getMemoryService()
    let includeUser = true
    try {
      const persona = memoryService?.getPersona(personaId)
      if (persona) includeUser = persona.captureUser
    } catch {
      includeUser = true
    }

    const userMessage = includeUser ? findPreviousUserMessage(session, message.id) : null
    const parts: string[] = []
    if (userMessage?.content.trim()) parts.push(`用户：${userMessage.content}`)
    if (message.content.trim()) parts.push(`助手：${message.content}`)
    const turnContent = parts.join('\n').trim()
    if (!turnContent) return

    const settings = deps.getSettings()
    const ingestion = memoryService?.ingestChatMessage(
      {
        personaId,
        sessionId,
        messageId: userMessage ? `turn:${userMessage.id}` : message.id,
        role: message.role,
        content: turnContent,
        createdAt: message.createdAt,
      },
      settings.memory,
      settings.ai,
    )
    if (ingestion) void ingestion.catch(() => {})
  } catch {
    // Chat persistence must not fail when optional memory ingestion is unavailable.
  }
}

export function registerChatPersistenceIpc(deps: ChatPersistenceIpcDependencies): void {
  const { handle, chatStore } = deps

  handle('chat:list', () => chatStore.listChatSessions())
  handle('chat:get', (_event, sessionId?: string) => chatStore.getChatSession(sessionId))
  handle('chat:create', (_event, name?: string, personaId?: string) => chatStore.createChatSession(name, personaId))
  handle('chat:setCurrent', (_event, sessionId: string) => chatStore.setCurrentChatSession(sessionId))
  handle('chat:rename', (_event, sessionId: string, name: string) => chatStore.renameChatSession(sessionId, name))
  handle('chat:delete', (_event, sessionId: string) => chatStore.deleteChatSession(sessionId))
  handle('chat:clear', (_event, sessionId: string) => chatStore.clearChatSession(sessionId))
  handle('chat:setMessages', (_event, sessionId: string, messages: ChatMessageRecord[]) =>
    chatStore.setChatMessages(sessionId, messages),
  )

  handle('chat:addMessage', (_event, sessionId: string, message: ChatMessageRecord) => {
    const session = chatStore.addChatMessage(sessionId, message)
    enqueueAssistantTurnMemory(deps, sessionId, session, message)
    return session
  })

  handle('chat:updateMessage', (_event, sessionId: string, messageId: string, content: string) => {
    const session = chatStore.updateChatMessage(sessionId, messageId, content)
    enqueueAssistantTurnMemory(deps, sessionId, session, session.messages.find((message) => message.id === messageId))
    return session
  })

  handle('chat:updateMessageRecord', (_event, sessionId: string, messageId: string, patch: unknown) => {
    const session = chatStore.updateChatMessageRecord(sessionId, messageId, patch)
    enqueueAssistantTurnMemory(deps, sessionId, session, session.messages.find((message) => message.id === messageId))
    return session
  })

  handle('chat:deleteMessage', (_event, sessionId: string, messageId: string) =>
    chatStore.deleteChatMessage(sessionId, messageId),
  )
  handle('chat:setAutoExtractCursor', (_event, sessionId: string, cursor: number) =>
    chatStore.setChatSessionAutoExtractCursor(sessionId, cursor),
  )
  handle('chat:setAutoExtractMeta', (_event, sessionId: string, patch: unknown) =>
    chatStore.setChatSessionAutoExtractMeta(sessionId, patch),
  )
}
