import { describe, expect, it, vi } from 'vitest'
import type { VisualArtifactRef } from '../electron/types'
import {
  TaskAgentVisionSession,
  normalizeImagePathList,
  normalizeVisualArtifacts,
  type TaskAgentVisualContext,
  type TaskAgentVisionSessionOptions,
} from '../electron/task/taskAgentVisionSession'

function artifact(id: string, imagePath = `C:\\images\\${id}.png`): VisualArtifactRef {
  return { id, path: imagePath, source: 'upload', createdAt: 10 }
}

function createContext(items: VisualArtifactRef[] = [artifact('a'), artifact('b'), artifact('c')]): TaskAgentVisualContext {
  return {
    artifacts: new Map(items.map((item) => [item.id, item])),
    initialVisionIds: items.map((item) => item.id),
  }
}

function createHarness(
  overrides: Partial<TaskAgentVisionSessionOptions> = {},
  context = createContext(),
) {
  const loadImageParts = vi.fn(async (paths: string[], limit: number) =>
    paths.slice(0, limit).map((imagePath) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imagePath}` },
    })),
  )
  const inspectFallbackArtifact = vi.fn(async (item: VisualArtifactRef) =>
    JSON.stringify({ answer: `observed ${item.id}` }),
  )
  const rememberMainCapability = vi.fn()
  const pushLog = vi.fn()
  const options: TaskAgentVisionSessionOptions = {
    taskId: 'task-1',
    taskCreatedAt: 10,
    visualContext: context,
    maxImages: 2,
    routingMode: 'auto',
    mainCapability: 'supported',
    mainAvailable: true,
    fallbackAvailable: true,
    fallbackOnTransient: true,
    loadImageParts,
    inspectFallbackArtifact,
    rememberMainCapability,
    pushLog,
    now: () => 100,
    ...overrides,
  }
  const session = new TaskAgentVisionSession(options)
  return { session, context, loadImageParts, inspectFallbackArtifact, rememberMainCapability, pushLog }
}

describe('Task agent vision session', () => {
  it('normalizes persisted artifacts and resolves valid IDs in requested order with a hard limit', () => {
    expect(normalizeImagePathList(['C:\\images\\one.png', 'C:\\\\images\\\\one.png', '', 'C:\\images\\two.png'])).toEqual([
      'C:\\images\\one.png',
      'C:\\images\\two.png',
    ])
    expect(
      normalizeVisualArtifacts([
        { id: 'same', path: 'C:\\first.png', source: 'upload' },
        { id: 'same', path: 'C:\\second.png', source: 'screen.capture' },
        { id: 'legacy', path: 'C:\\legacy.png', source: 'unknown' },
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'same', path: 'C:\\first.png', source: 'upload' }),
      expect.objectContaining({ id: 'legacy', path: 'C:\\legacy.png', source: 'legacy' }),
    ])

    const context = createContext()
    context.initialVisionIds = ['b', 'missing', 'a', 'b', 'c']
    const { session } = createHarness({}, context)

    expect(session.resolveArtifacts(context.initialVisionIds).map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('prepares main-model images and marks the effective capability after a successful request', async () => {
    const context = createContext([artifact('a'), artifact('b')])
    const harness = createHarness({}, context)

    const state = await harness.session.prepareInitial('compare them')
    const messages: Array<Record<string, unknown>> = []
    harness.session.appendInitialSystemMessages(messages)
    const userContent = harness.session.buildInitialUserContent('compare them')
    harness.session.markMainRequestSucceeded()

    expect(state).toMatchObject({ route: 'main', artifacts: [{ id: 'a' }, { id: 'b' }] })
    expect(state.imageParts).toHaveLength(2)
    expect(messages[0]?.content).toContain('a、b')
    expect(userContent).toEqual([
      { type: 'text', text: 'compare them' },
      expect.objectContaining({ type: 'image_url' }),
      expect.objectContaining({ type: 'image_url' }),
    ])
    expect(harness.rememberMainCapability).toHaveBeenCalledWith('supported')
  })

  it('routes initial images through fallback or keeps them detached when vision is off', async () => {
    const fallback = createHarness({ mainCapability: 'unsupported' }, createContext([artifact('a')]))
    const fallbackState = await fallback.session.prepareInitial('what is visible?')
    const fallbackMessages: Array<Record<string, unknown>> = []
    fallback.session.appendInitialSystemMessages(fallbackMessages)

    expect(fallbackState.route).toBe('fallback')
    expect(fallback.inspectFallbackArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'what is visible?')
    expect(fallbackMessages[0]?.content).toContain('- a：observed a')

    const off = createHarness({ routingMode: 'off' }, createContext([artifact('a')]))
    const offState = await off.session.prepareInitial('ignored')

    expect(offState.route).toBe('off')
    expect(off.loadImageParts).not.toHaveBeenCalled()
    expect(off.inspectFallbackArtifact).not.toHaveBeenCalled()
    expect(off.pushLog).toHaveBeenCalledWith('[Vision] 不支持或未配置可用视觉路由')
  })

  it('strips rejected image parts, injects fallback evidence, and updates capability for the current session', async () => {
    const harness = createHarness({}, createContext([artifact('a')]))
    await harness.session.prepareInitial('read the label')
    const messages: Array<Record<string, unknown>> = []
    harness.session.appendInitialSystemMessages(messages)
    messages.push({ role: 'user', content: harness.session.buildInitialUserContent('read the label') })

    await expect(
      harness.session.recoverFromMainVisionError(messages, new Error('image input is unsupported for this model'), 400),
    ).resolves.toBe(true)

    expect(messages.find((message) => message.role === 'user')?.content).toBe('read the label')
    expect(messages.find((message) => message.role === 'system')?.content).toContain('主模型不支持→外挂')
    expect(messages.find((message) => message.role === 'system')?.content).toContain('- a：observed a')
    expect(harness.rememberMainCapability).toHaveBeenCalledWith('unsupported')

    const look = await harness.session.executeVisionLook({ artifactIds: ['a'], question: 'again' })
    expect(look.modelOutput).toContain('外挂视觉模型')
    expect(harness.loadImageParts).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation while fallback inspection is running without stripping image messages', async () => {
    let canceled = false
    const inspectFallbackArtifact = vi.fn(async () => {
      canceled = true
      throw new Error('canceled')
    })
    const harness = createHarness(
      {
        inspectFallbackArtifact,
        isCanceled: () => canceled,
      },
      createContext([artifact('a')]),
    )
    await harness.session.prepareInitial('inspect')
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: harness.session.buildInitialUserContent('inspect') },
    ]

    await expect(
      harness.session.recoverFromMainVisionError(messages, new Error('image input is unsupported'), 400),
    ).rejects.toThrow('canceled')
    expect(Array.isArray(messages[0]?.content)).toBe(true)
  })

  it('executes vision.look on main and fallback routes and rejects duplicate, unknown, or excess IDs', async () => {
    const main = createHarness({}, createContext([artifact('a'), artifact('b'), artifact('c')]))
    const mainResult = await main.session.executeVisionLook({ artifactIds: ['b', 'a'], question: 'compare' })

    expect(mainResult.visionParts).toHaveLength(2)
    expect(main.loadImageParts).toHaveBeenCalledWith(['C:\\images\\b.png', 'C:\\images\\a.png'], 2)
    await expect(main.session.executeVisionLook({ artifactIds: ['a', 'a'] })).rejects.toThrow('重复')
    await expect(main.session.executeVisionLook({ artifactIds: ['a', 'missing'] })).rejects.toThrow('未知')
    await expect(main.session.executeVisionLook({ artifactIds: ['a', 'b', 'c'] })).rejects.toThrow('超出上限')

    const fallback = createHarness({ routingMode: 'fallback-only' }, createContext([artifact('a')]))
    const fallbackResult = await fallback.session.executeVisionLook({ artifactIds: ['a'], question: 'read' })
    expect(fallbackResult.modelOutput).toContain('- a：observed a')

    const off = createHarness({ routingMode: 'off' }, createContext([artifact('a')]))
    await expect(off.session.executeVisionLook({ artifactIds: ['a'] })).rejects.toThrow('视觉路由已关闭')
  })

  it('registers ordered tool artifacts and exposes only safe IDs to the model and fallback catalog', async () => {
    const context = createContext([])
    const harness = createHarness({ legacyImagePaths: ['C:\\legacy.png'] }, context)
    const generated = harness.session.registerToolVisualArtifacts('image.generate', 'run-1', [
      'C:\\generated-1.png',
      'C:\\generated-2.png',
    ])
    const captured = harness.session.registerToolVisualArtifacts('screen.capture', 'run-2', ['C:\\screen.png'])

    expect(generated).toEqual([
      expect.objectContaining({ id: 'vis_task-1_run-1_1', groupId: 'task-1:run-1', index: 1, total: 2 }),
      expect.objectContaining({ id: 'vis_task-1_run-1_2', groupId: 'task-1:run-1', index: 2, total: 2 }),
    ])
    expect(captured[0]).toMatchObject({ id: 'vis_task-1_run-2_1', source: 'screen.capture', index: 1, total: 1 })
    const safeOutput = harness.session.sanitizeToolOutputForModel('{"path":"C:\\\\generated-1.png"}', generated)
    expect(safeOutput).toContain('vis_task-1_run-1_1')
    expect(safeOutput).not.toContain('C:\\generated-1.png')

    const fallbackMessages: Array<Record<string, unknown>> = []
    harness.session.appendTextFallbackSystemMessages(fallbackMessages)
    expect(fallbackMessages[0]?.content).toContain('legacy_task-1_1')
    expect(fallbackMessages[0]?.content).toContain('vis_task-1_run-2_1')
  })
})
