import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskMmvectorVideoQaWorkflow,
  type TaskMmvectorVideoQaContext,
} from '../electron/task/taskMmvectorVideoQa'
import type { ToolInput } from '../electron/toolExecutor'
import type { TaskRecord } from '../electron/types'

const roots: string[] = []

function fixture(): { root: string; userDataDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-mmvector-workflow-'))
  const userDataDir = path.join(root, 'userData')
  mkdirSync(userDataDir)
  roots.push(root)
  return { root, userDataDir }
}

function task(): TaskRecord {
  return { id: 'task-mmvector' } as TaskRecord
}

function context(
  executeTool: (toolName: string, input: ToolInput) => Promise<{ output: string }>,
  isCanceled = vi.fn(() => false),
): TaskMmvectorVideoQaContext {
  return {
    task: task(),
    waitIfPaused: vi.fn(async () => undefined),
    isCanceled,
    setCancelCurrent: vi.fn(),
    executeTool: vi.fn(executeTool),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Task mmvector video QA workflow', () => {
  it('copies a local video into the managed cache and forwards clamped QA options', async () => {
    const dirs = fixture()
    const source = path.join(dirs.root, 'outside', 'source.mp4')
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, Buffer.from([1, 2, 3, 4]))

    let qaInput: ToolInput = null
    const toolContext = context(async (toolName, input) => {
      if (toolName === 'mcp.mmvector.search_by_text') {
        expect(input).toEqual({ query: 'dogs', topK: 20, filter: 'video', minScore: 1 })
        return {
          output: `result:\n${JSON.stringify({
            ok: true,
            results: [{ id: 7, score: 0.9, filename: 'picked.mp4', videoPath: source }],
          })}`,
        }
      }
      qaInput = input
      return { output: '{"answer":"two dogs"}' }
    })
    const workflow = new TaskMmvectorVideoQaWorkflow({
      userDataDir: dirs.userDataDir,
      createId: () => 'copy-1',
      now: () => 1_000,
    })

    const output = await workflow.run(
      {
        searchQuery: ' dogs ',
        question: 'How many?',
        topK: 99,
        minScore: 2,
        segmentSeconds: 1,
        framesPerSegment: 20,
        maxSegments: 0,
        startSeconds: -5,
        timeoutMs: 10_000,
        model: 'vision-model',
      },
      toolContext,
    )

    const qa = qaInput as unknown as Record<string, unknown>
    const cachedPath = String(qa.videoPath)
    expect(cachedPath).toMatch(/video-qa-cache[\\/]picked-copy-1\.mp4$/)
    expect(cachedPath).not.toBe(source)
    expect(readFileSync(cachedPath)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(qa).toMatchObject({
      question: 'How many?',
      segmentSeconds: 5,
      framesPerSegment: 8,
      maxSegments: 1,
      startSeconds: 0,
      timeoutMs: 10_000,
      model: 'vision-model',
    })
    expect(toolContext.waitIfPaused).toHaveBeenCalledTimes(3)
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      search: { query: 'dogs', picked: { id: 7, localVideoPath: cachedPath } },
      qa: { answer: 'two dogs' },
    })
  })

  it('returns a bounded failure result when search has no usable video', async () => {
    const dirs = fixture()
    const toolContext = context(async () => ({ output: '{"ok":true,"results":[]}' }))
    const workflow = new TaskMmvectorVideoQaWorkflow({ userDataDir: dirs.userDataDir })

    const output = await workflow.run({ searchQuery: 'missing', question: 'What is shown?' }, toolContext)

    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: 'mmvector 未命中任何视频',
      searchQuery: 'missing',
    })
    expect(toolContext.executeTool).toHaveBeenCalledTimes(1)
  })

  it('streams a remote video into a unique cache file and clears the cancel hook', async () => {
    const dirs = fixture()
    const bytes = Buffer.from([5, 6, 7])
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }))
    let qaPath = ''
    const toolContext = context(async (toolName, input) => {
      if (toolName === 'mcp.mmvector.search_by_text') {
        return {
          output: JSON.stringify({
            ok: true,
            results: [{ filename: 'remote.webm', videoUrl: 'https://example.com/video' }],
          }),
        }
      }
      qaPath = String((input as Record<string, unknown>).videoPath)
      return { output: 'remote answer' }
    })
    const workflow = new TaskMmvectorVideoQaWorkflow({
      userDataDir: dirs.userDataDir,
      maxVideoBytes: 10,
      createId: () => 'remote-1',
      fetchImpl,
    })

    const output = await workflow.run({ searchQuery: 'remote', question: 'What happens?' }, toolContext)

    expect(fetchImpl).toHaveBeenCalledWith(new URL('https://example.com/video'), expect.objectContaining({ method: 'GET' }))
    expect(qaPath).toMatch(/video-qa-cache[\\/]remote-remote-1\.webm$/)
    expect(readFileSync(qaPath)).toEqual(bytes)
    expect(toolContext.setCancelCurrent).toHaveBeenLastCalledWith(undefined)
    expect(JSON.parse(output).qa).toBe('remote answer')
  })

  it('removes a partial remote download when the streamed body exceeds the limit', async () => {
    const dirs = fixture()
    const fetchImpl = vi.fn(async () => new Response(Buffer.from([1, 2, 3, 4, 5]), { status: 200 }))
    const toolContext = context(async (toolName) => {
      if (toolName === 'mcp.mmvector.search_by_text') {
        return {
          output: JSON.stringify({
            ok: true,
            results: [{ filename: 'large.mp4', videoUrl: 'https://example.com/large.mp4' }],
          }),
        }
      }
      return { output: 'unexpected' }
    })
    const workflow = new TaskMmvectorVideoQaWorkflow({
      userDataDir: dirs.userDataDir,
      maxVideoBytes: 4,
      createId: () => 'large-1',
      fetchImpl,
    })

    await expect(workflow.run({ searchQuery: 'large', question: 'What happens?' }, toolContext)).rejects.toThrow(
      '下载视频文件大小不受支持',
    )

    const cacheDir = path.join(dirs.userDataDir, 'video-qa-cache')
    expect(readdirSync(cacheDir)).toEqual([])
    expect(toolContext.executeTool).toHaveBeenCalledTimes(1)
    expect(toolContext.setCancelCurrent).toHaveBeenLastCalledWith(undefined)
  })

  it('does not delete an existing cache file when a generated name collides', async () => {
    const dirs = fixture()
    const cacheDir = path.join(dirs.userDataDir, 'video-qa-cache')
    const existing = path.join(cacheDir, 'collision-same.mp4')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(existing, Buffer.from([9, 9]))

    const toolContext = context(async () => ({
      output: JSON.stringify({
        ok: true,
        results: [{ filename: 'collision.mp4', videoUrl: 'https://example.com/collision.mp4' }],
      }),
    }))
    const workflow = new TaskMmvectorVideoQaWorkflow({
      userDataDir: dirs.userDataDir,
      createId: () => 'same',
      fetchImpl: vi.fn(async () => new Response(Buffer.from([1, 2]), { status: 200 })),
    })

    await expect(workflow.run({ searchQuery: 'collision', question: 'Question?' }, toolContext)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(readFileSync(existing)).toEqual(Buffer.from([9, 9]))
  })

  it('stops after search when the task is canceled or the workflow deadline expires', async () => {
    const dirs = fixture()
    let canceled = false
    let currentTime = 0
    const canceledContext = context(
      async () => {
        canceled = true
        return { output: '{"ok":true,"results":[]}' }
      },
      vi.fn(() => canceled),
    )
    const canceledWorkflow = new TaskMmvectorVideoQaWorkflow({ userDataDir: dirs.userDataDir })
    await expect(
      canceledWorkflow.run({ searchQuery: 'cancel', question: 'Question?' }, canceledContext),
    ).rejects.toThrow('任务已取消')

    const timeoutContext = context(async () => {
      currentTime = 5_000
      return { output: '{"ok":true,"results":[]}' }
    })
    const timeoutWorkflow = new TaskMmvectorVideoQaWorkflow({
      userDataDir: dirs.userDataDir,
      now: () => currentTime,
    })
    await expect(
      timeoutWorkflow.run({ searchQuery: 'timeout', question: 'Question?', timeoutMs: 5_000 }, timeoutContext),
    ).rejects.toThrow('workflow.mmvector_video_qa timeout')
  })
})
