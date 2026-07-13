import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerChatPersistenceIpc, type ChatStoreOperations } from '../electron/ipc/registerChatPersistenceIpc'
import type { IpcHandle } from '../electron/ipc/registration'
import { type IpcChannel } from '../electron/ipcPermissions'
import { createDefaultSettings } from '../electron/store'
import type { ChatMessageRecord, ChatSession, Persona } from '../electron/types'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const persistenceChannels: IpcChannel[] = [
  'chat:list',
  'chat:get',
  'chat:create',
  'chat:setCurrent',
  'chat:rename',
  'chat:delete',
  'chat:clear',
  'chat:setMessages',
  'chat:addMessage',
  'chat:updateMessage',
  'chat:updateMessageRecord',
  'chat:deleteMessage',
  'chat:setAutoExtractCursor',
  'chat:setAutoExtractMeta',
]

function message(id: string, role: ChatMessageRecord['role'], content: string, createdAt: number): ChatMessageRecord {
  return { id, role, content, createdAt }
}

function createSession(messages: ChatMessageRecord[] = []): ChatSession {
  return {
    id: 'session-1',
    name: 'Session',
    personaId: 'persona-1',
    createdAt: 1,
    updatedAt: 1,
    messages,
  }
}

function createPersona(captureUser: boolean): Persona {
  return {
    id: 'persona-1',
    name: 'Persona',
    prompt: '',
    captureEnabled: true,
    captureUser,
    captureAssistant: true,
    retrieveEnabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createHarness(options?: {
  captureUser?: boolean
  memoryEnabled?: boolean
  memoryAvailable?: boolean
  ingestRejects?: boolean
}) {
  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => {
    handlers.set(channel, listener)
  }) as IpcHandle
  const settings = createDefaultSettings()
  settings.memory.enabled = options?.memoryEnabled ?? true
  let session = createSession()
  const ingestChatMessage = vi.fn(async () => {
    if (options?.ingestRejects) throw new Error('memory unavailable')
  })
  const getPersona = vi.fn(() => createPersona(options?.captureUser ?? true))

  const chatStore: ChatStoreOperations = {
    listChatSessions: vi.fn(() => ({ sessions: [], currentSessionId: session.id })),
    getChatSession: vi.fn(() => session),
    createChatSession: vi.fn(() => session),
    setCurrentChatSession: vi.fn((sessionId) => ({ currentSessionId: sessionId })),
    renameChatSession: vi.fn((_sessionId, name) => ({
      id: session.id,
      name,
      personaId: session.personaId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    })),
    deleteChatSession: vi.fn(() => ({ sessions: [], currentSessionId: '' })),
    clearChatSession: vi.fn(() => {
      session = { ...session, messages: [] }
      return session
    }),
    setChatMessages: vi.fn((_sessionId, messages) => {
      session = { ...session, messages }
      return session
    }),
    addChatMessage: vi.fn((_sessionId, nextMessage) => {
      session = { ...session, messages: [...session.messages, nextMessage] }
      return session
    }),
    updateChatMessage: vi.fn((_sessionId, messageId, content) => {
      session = {
        ...session,
        messages: session.messages.map((item) => item.id === messageId ? { ...item, content } : item),
      }
      return session
    }),
    updateChatMessageRecord: vi.fn((_sessionId, messageId, patch) => {
      const safePatch = patch && typeof patch === 'object' ? patch as Partial<ChatMessageRecord> : {}
      session = {
        ...session,
        messages: session.messages.map((item) => item.id === messageId ? { ...item, ...safePatch } : item),
      }
      return session
    }),
    deleteChatMessage: vi.fn((_sessionId, messageId) => {
      session = { ...session, messages: session.messages.filter((item) => item.id !== messageId) }
      return session
    }),
    setChatSessionAutoExtractCursor: vi.fn((_sessionId, cursor) => {
      session = { ...session, autoExtractCursor: cursor }
      return session
    }),
    setChatSessionAutoExtractMeta: vi.fn(() => session),
  }

  registerChatPersistenceIpc({
    handle,
    chatStore,
    getSettings: () => settings,
    getMemoryService: () => options?.memoryAvailable === false ? null : { getPersona, ingestChatMessage },
  })

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({} as IpcMainInvokeEvent, ...args) as Result
  }

  return { handlers, invoke, chatStore, ingestChatMessage, getPersona }
}

describe('chat persistence IPC registration', () => {
  it('registers the complete persistence channel set', () => {
    const harness = createHarness()
    expect([...harness.handlers.keys()].sort()).toEqual([...persistenceChannels].sort())
  })

  it('delegates session operations without changing their results', () => {
    const harness = createHarness()
    expect(harness.invoke('chat:setCurrent', 'session-2')).toEqual({ currentSessionId: 'session-2' })
    expect(harness.chatStore.setCurrentChatSession).toHaveBeenCalledWith('session-2')

    expect(harness.invoke('chat:rename', 'session-1', 'Renamed')).toMatchObject({ name: 'Renamed' })
    expect(harness.invoke('chat:setAutoExtractCursor', 'session-1', 12)).toMatchObject({ autoExtractCursor: 12 })
  })

  it('ingests the same user-assistant turn after add and update operations', () => {
    const harness = createHarness()
    harness.invoke('chat:setMessages', 'session-1', [message('u1', 'user', '问题', 1)])
    harness.invoke('chat:addMessage', 'session-1', message('a1', 'assistant', '初始回答', 2))

    expect(harness.ingestChatMessage).toHaveBeenLastCalledWith(
      {
        personaId: 'persona-1',
        sessionId: 'session-1',
        messageId: 'turn:u1',
        role: 'assistant',
        content: '用户：问题\n助手：初始回答',
        createdAt: 2,
      },
      expect.objectContaining({ enabled: true }),
      expect.any(Object),
    )

    harness.invoke('chat:updateMessage', 'session-1', 'a1', '编辑回答')
    expect(harness.ingestChatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'turn:u1', content: '用户：问题\n助手：编辑回答' }),
      expect.any(Object),
      expect.any(Object),
    )

    harness.invoke('chat:updateMessageRecord', 'session-1', 'a1', { content: '结构化更新' })
    expect(harness.ingestChatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'turn:u1', content: '用户：问题\n助手：结构化更新' }),
      expect.any(Object),
      expect.any(Object),
    )
  })

  it('omits user text when the persona disables captureUser and skips disabled memory', () => {
    const assistantOnly = createHarness({ captureUser: false })
    assistantOnly.invoke('chat:setMessages', 'session-1', [message('u1', 'user', '私密问题', 1)])
    assistantOnly.invoke('chat:addMessage', 'session-1', message('a1', 'assistant', '回答', 2))
    expect(assistantOnly.ingestChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'a1', content: '助手：回答' }),
      expect.any(Object),
      expect.any(Object),
    )

    const disabled = createHarness({ memoryEnabled: false })
    disabled.invoke('chat:addMessage', 'session-1', message('a1', 'assistant', '回答', 2))
    expect(disabled.ingestChatMessage).not.toHaveBeenCalled()
  })

  it('keeps chat writes successful when memory ingestion is unavailable or rejects', async () => {
    const unavailable = createHarness({ memoryAvailable: false })
    expect(unavailable.invoke<ChatSession>('chat:addMessage', 'session-1', message('a1', 'assistant', '回答', 2)))
      .toMatchObject({ messages: [expect.objectContaining({ id: 'a1' })] })

    const rejecting = createHarness({ ingestRejects: true })
    expect(rejecting.invoke<ChatSession>('chat:addMessage', 'session-1', message('a1', 'assistant', '回答', 2)))
      .toMatchObject({ messages: [expect.objectContaining({ id: 'a1' })] })
    await Promise.resolve()
  })
})
