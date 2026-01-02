import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  AppSettings,
  BubbleStyle,
  ChatMessageRecord,
  ChatSessionSummary,
  MemoryRetrieveResult,
  Persona,
  PersonaSummary,
  TaskCreateArgs,
  TaskRecord,
  TailDirection,
} from '../electron/types'
import { getApi } from './neoDeskPetApi'
import { getWindowType } from './windowType'
import { MemoryConsoleWindow } from './windows/MemoryConsoleWindow'
import { Live2DView } from './live2d/Live2DView'
import { SpeechBubble } from './components/SpeechBubble'
import {
  getAvailableModels,
  parseModelMetadata,
  scanAvailableModels,
  type Live2DModelInfo,
} from './live2d/live2dModels'
import { ABORTED_ERROR, AIService, getAIService, setModelInfoToAIService, type ChatMessage } from './services/aiService'
import { TtsPlayer } from './services/ttsService'
import { createStreamingSentenceSegmenter, splitTextIntoSegments } from './services/textSegmentation'

function App() {
  const windowType = getWindowType()
  const api = useMemo(() => getApi(), [])

  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  if (windowType === 'chat') {
    return <ChatWindow api={api} />
  }

  if (windowType === 'settings') {
    return <SettingsWindow api={api} settings={settings} />
  }

  if (windowType === 'memory') {
    return <MemoryConsoleWindow api={api} settings={settings} />
  }

  return <PetWindow />
}

export default App

type EffectiveChatMessage = {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

function collapseAssistantRuns(messages: ChatMessageRecord[]): EffectiveChatMessage[] {
  const out: EffectiveChatMessage[] = []
  for (const m of messages) {
    const content = (m.content ?? '').trim()
    if (!content) continue

    if (m.role === 'assistant') {
      const last = out[out.length - 1]
      if (last && last.role === 'assistant') {
        last.content = `${last.content}\n${content}`
        last.createdAt = Math.min(last.createdAt, m.createdAt)
        continue
      }
      out.push({ role: 'assistant', content, createdAt: m.createdAt })
      continue
    }

    out.push({ role: 'user', content, createdAt: m.createdAt })
  }
  return out
}

function sliceTail<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  return items.slice(items.length - max)
}

function clampIntValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const TASK_PLANNER_TOOLS = [
  'browser.fetch',
  'browser.playwright',
  'file.write',
  'cli.exec',
  'llm.summarize',
  'llm.chat',
  'delay.sleep',
] as const

type PlannerDecision =
  | { type: 'create_task'; assistantReply: string; task: TaskCreateArgs }
  | { type: 'need_info'; assistantReply: string; questions?: string[] }
  | { type: 'chat'; assistantReply: string }

function looksLikeToolTaskRequest(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (/https?:\/\/\S+/i.test(t)) return true

  const taskKeywords = [
    '帮我',
    '抓取',
    '爬取',
    '截图',
    '打开',
    '访问',
    '浏览器',
    'b站',
    'B站',
    'bilibili',
    '下载',
    '保存',
    '写入',
    '生成文件',
    '整理',
    '归档',
    '执行',
    '运行',
    '命令',
    'powershell',
    'cmd',
    '终端',
    '总结网页',
    '总结这个网站',
  ]
  return taskKeywords.some((k) => t.includes(k))
}

function extractFirstJsonObject(text: string): string | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function normalizePlannerTask(raw: unknown): TaskCreateArgs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!title) return null

  const queue = typeof obj.queue === 'string' ? obj.queue.trim() : undefined
  const why = typeof obj.why === 'string' ? obj.why.trim() : undefined

  const stepsRaw = Array.isArray(obj.steps) ? (obj.steps as unknown[]) : []
  const steps = stepsRaw.slice(0, 20).map((step) => {
    const s = step && typeof step === 'object' && !Array.isArray(step) ? (step as Record<string, unknown>) : {}
    const tool = typeof s.tool === 'string' ? s.tool.trim() : undefined
    const title = typeof s.title === 'string' ? s.title.trim() : tool ? tool : '步骤'

    let input: string | undefined
    if (typeof s.input === 'string') input = s.input
    else if (s.input && (typeof s.input === 'object' || Array.isArray(s.input))) {
      try {
        input = JSON.stringify(s.input)
      } catch {
        input = undefined
      }
    }

    return { title, tool, input }
  })

  return { queue: queue as TaskCreateArgs['queue'], title, why, steps }
}

function parsePlannerDecision(text: string): PlannerDecision | null {
  const jsonStr = extractFirstJsonObject(text)
  if (!jsonStr) return null

  let obj: unknown
  try {
    obj = JSON.parse(jsonStr) as unknown
  } catch {
    return null
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const root = obj as Record<string, unknown>
  const type = typeof root.type === 'string' ? root.type.trim() : ''
  const assistantReply = typeof root.assistantReply === 'string' ? root.assistantReply.trim() : ''

  if (type === 'need_info') {
    const qRaw = Array.isArray(root.questions) ? (root.questions as unknown[]) : []
    const questions = qRaw.filter((x) => typeof x === 'string').map((x) => String(x).trim()).filter(Boolean)
    return {
      type: 'need_info',
      assistantReply: assistantReply || (questions[0] ? questions.join('\n') : '我还需要你补充一些信息。'),
      questions: questions.length ? questions : undefined,
    }
  }

  if (type === 'create_task') {
    const task = normalizePlannerTask(root.task)
    if (!task) return null
    return {
      type: 'create_task',
      assistantReply: assistantReply || `好的，我会开始执行：${task.title}`,
      task,
    }
  }

  if (type === 'chat') {
    return { type: 'chat', assistantReply: assistantReply || '' }
  }

  return null
}

function buildPlannerSystemPrompt(): string {
  const lines: string[] = []
  lines.push('你是 NeoDeskPet 的“任务规划器（Planner）”。你的工作是：根据用户的自然语言请求，决定是否要创建“可执行任务（Task）”，并输出严格 JSON。')
  lines.push('')
  lines.push('你只能输出一个 JSON 对象，禁止输出 Markdown、代码块、解释文字。')
  lines.push('')
  lines.push('优化目标：优先选择“延迟最低且成功率高”的方案；只有在必要时才用更重的工具。')
  lines.push('')
  lines.push('你有三种输出类型：')
  lines.push('1) create_task：当用户想让桌宠做事（抓取网页/截图/运行命令/写文件/总结等）时。')
  lines.push('2) need_info：当信息不足以执行时（例如“抓取B站”但没有 URL/关键词/目标）。你要用一句话追问。')
  lines.push('3) chat：普通闲聊/不需要工具时。')
  lines.push('')
  lines.push('输出 JSON 结构：')
  lines.push('- create_task:')
  lines.push(
    '  {"type":"create_task","assistantReply":"...","task":{"queue":"browser|file|cli|chat|learning|play|other","title":"...","why":"...","steps":[{"title":"...","tool":"...","input":"..."}]}}',
  )
  lines.push('- need_info:')
  lines.push('  {"type":"need_info","assistantReply":"...","questions":["..."]}')
  lines.push('- chat:')
  lines.push('  {"type":"chat","assistantReply":"..."}')
  lines.push('')
  lines.push(`工具列表（step.tool 只能从这里选）：${TASK_PLANNER_TOOLS.join(', ')}`)
  lines.push('')
  lines.push('各工具输入约定（step.input 必须是字符串；如果是 JSON，请把 JSON stringify 成字符串）：')
  lines.push('- browser.fetch：{"url":"https://...","maxChars":5000,"timeoutMs":15000,"stripHtml":false}')
  lines.push(
    '- browser.playwright：{"url":"https://...","headless":true,"channel":"msedge","profile":"default","screenshot":{"path":"task-output/xxx.png","fullPage":false},"extract":{"selector":"body","format":"innerText|text|html","maxChars":1200,"optional":true},"actions":[{"type":"waitMs","ms":1200},{"type":"click","selector":"..."},{"type":"fill","selector":"...","text":"..."},{"type":"press","selector":"...","key":"Enter"},{"type":"waitForLoad","state":"networkidle"}]}（省略 extract 表示不提取页面文本；只“打开网页”不要加 extract）',
  )
  lines.push('- file.write：{"path":"task-output/xxx.txt"} 或 {"filename":"xxx.txt","content":"...","append":false,"encoding":"utf8"}')
  lines.push('- cli.exec："dir"（字符串命令）或 {"cmd":"powershell","args":["-NoProfile","-Command","..."]}')
  lines.push('- llm.summarize / llm.chat：{"prompt":"...","system":"(可选)","maxTokens":1200}')
  lines.push('- delay.sleep：{"ms":200}')
  lines.push('')
  lines.push('策略：')
  lines.push('- 能直接执行就 create_task；缺信息就 need_info；都不是就 chat。')
  lines.push('- 如果用户是在询问“你能做什么/有哪些工具/工具列表/能力说明”，一律输出 chat：列出可用工具与典型用法示例，不要创建任务、更不要实际执行。')
  lines.push('- 抓取/总结网页：优先 browser.fetch（更快）；遇到动态/需要登录/需要点击交互，才用 browser.playwright。')
  lines.push('- 仅“打开某网站”：用 browser.playwright，默认不做 extract；如果用户需要页面内容/摘要，才加 extract。')
  lines.push('- 默认避免高风险动作（删除/覆盖重要文件、支付、发送敏感信息）。遇到此类请求优先 need_info 让用户确认。')
  lines.push('- assistantReply 用中文，语气友好自然，简短说明你要做什么/需要什么，并尽量点出将使用的 tool。')
  return lines.join('\n')
}

function formatTaskFinalMessage(task: TaskRecord): string {
  const label = task.status === 'done' ? '任务完成' : task.status === 'failed' ? '任务失败' : '任务结束'
  const lines: string[] = [`[${label}] ${task.title}`]

  if (task.status === 'failed') {
    const err = (task.lastError ?? '').trim()
    if (err) lines.push(`原因：${err}`)
  }

  const lastStepWithOutput = [...(task.steps ?? [])].reverse().find((s) => (s.output ?? '').trim().length > 0)
  const out = (lastStepWithOutput?.output ?? '').trim()
  if (out) {
    const preview = out.length > 900 ? `${out.slice(0, 900)}…` : out
    lines.push('结果：')
    lines.push(preview)
  }

  lines.push('（可在桌宠任务面板查看详情）')
  return lines.join('\n')
}

function PetWindow() {
  const api = useMemo(() => getApi(), [])
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isOverModel = useRef(true)
  const clickStartTime = useRef(0)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const ttsPlayerRef = useRef<TtsPlayer | null>(null)
  const ttsQueueRef = useRef<{ utteranceId: string; segments: string[]; nextIndex: number; finalized: boolean } | null>(null)
  const ttsQueueRunningRef = useRef(false)
  const [mouthOpen, setMouthOpen] = useState(0)
  const [bubblePayload, setBubblePayload] = useState<
    | { text: string; startAt: number | null; mode: 'typing' | 'append'; autoHideDelay?: number }
    | null
  >(null)
  const [tasks, setTasks] = useState<TaskRecord[]>([])

  // Default click phrases (used if settings not loaded yet)
  const defaultPhrases = [
    '主人好呀~',
    '有什么事吗？',
    '嗯？怎么了~',
    '今天也要加油哦！',
    '想我了吗？',
  ]

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  // Listen for task list updates (M2 mini panel)
  useEffect(() => {
    if (!api) return

    let disposed = false
    api
      .listTasks()
      .then((res) => {
        if (disposed) return
        setTasks(res.items ?? [])
      })
      .catch((err) => console.error(err))

    const off = api.onTasksChanged((payload) => setTasks(payload.items ?? []))
    return () => {
      disposed = true
      api.setPetOverlayHover(false)
      off()
    }
  }, [api])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Listen for bubble messages from chat window
  useEffect(() => {
    if (!api) return
    return api.onBubbleMessage((message) => {
      const s = settingsRef.current
      if (!s) return

      const showBubble = s.bubble?.showOnChat ?? false
      const tts = s.tts

      const startTypingNow = () => {
        if (!showBubble) return
        setBubblePayload({ text: message, startAt: Date.now(), mode: 'typing' })
      }

      if (tts?.enabled) {
        if (showBubble) setBubblePayload({ text: message, startAt: null, mode: 'typing' })
        if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

        void ttsPlayerRef.current
          .speak(message, tts, {
            onFirstPlay: () => {
              if (showBubble) setBubblePayload({ text: message, startAt: Date.now(), mode: 'typing' })
            },
            onEnded: () => setMouthOpen(0),
          })
          .catch(() => {
            // TTS 失败时也要能正常显示气泡
            startTypingNow()
          })
        return
      }

      startTypingNow()
    })
  }, [api])

  // Listen for segmented TTS utterances from chat window
  useEffect(() => {
    if (!api) return

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

    const startQueueIfNeeded = () => {
      if (ttsQueueRunningRef.current) return
      ttsQueueRunningRef.current = true

      void (async () => {
        try {
          let keepLooping = true
          while (keepLooping) {
            const current = ttsQueueRef.current
            const s = settingsRef.current
            if (!current || !s?.tts?.enabled || !s?.tts?.segmented) break

            if (current.nextIndex >= current.segments.length) {
              if (current.finalized) {
                api.reportTtsUtteranceEnded({ utteranceId: current.utteranceId })
                ttsQueueRef.current = null
                keepLooping = false
                break
              }
              keepLooping = false
              break
            }

            const utteranceId = current.utteranceId
            const segmentIndex = current.nextIndex
            const text = current.segments[current.nextIndex] || ''
            current.nextIndex += 1

            if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
            const player = ttsPlayerRef.current
            if (!player) break

            const ttsSettings = settingsRef.current?.tts
            if (!ttsSettings) break

            try {
              await new Promise<void>((resolve, reject) => {
                void player
                  .speak(text, ttsSettings, {
                    onFirstPlay: () => {
                      api.reportTtsSegmentStarted({ utteranceId, segmentIndex, text })

                      const s = settingsRef.current
                      const showBubble = s?.bubble?.showOnChat ?? false
                      if (!showBubble) return
                      setBubblePayload({ text, startAt: Date.now(), mode: 'append', autoHideDelay: 0 })
                    },
                    onEnded: resolve,
                  })
                  .catch(reject)
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              api.reportTtsUtteranceFailed({ utteranceId, error: msg })
              ttsQueueRef.current = null
              break
            }

            if (!ttsQueueRef.current || ttsQueueRef.current.utteranceId !== utteranceId) {
              keepLooping = false
              break
            }

            // 一句读完后关闭气泡，下一句会重新弹出
            const showBubble = settingsRef.current?.bubble?.showOnChat ?? false
            if (showBubble) setBubblePayload(null)

            const pauseMs = Math.max(0, Math.min(5000, settingsRef.current?.tts?.pauseMs ?? 280))
            if (pauseMs > 0) await sleep(pauseMs)
          }
        } finally {
          ttsQueueRunningRef.current = false
          // 若队列在运行期间被追加了新 segment，尝试继续
          const next = ttsQueueRef.current
          const s = settingsRef.current
          if (next && s?.tts?.enabled && s?.tts?.segmented && next.nextIndex < next.segments.length) {
            startQueueIfNeeded()
          }
        }
      })()
    }

    const unsubEnqueue = api.onTtsEnqueue((payload) => {
      const s = settingsRef.current
      if (!s?.tts?.enabled || !s.tts.segmented) return

      if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

      const isReplace = payload.mode === 'replace'
      const prev = ttsQueueRef.current
      const differentUtterance = !prev || prev.utteranceId !== payload.utteranceId

      if (isReplace || differentUtterance) {
        if (prev && prev.utteranceId !== payload.utteranceId) {
          api.reportTtsUtteranceEnded({ utteranceId: prev.utteranceId })
        }
        ttsPlayerRef.current?.stop()
        setMouthOpen(0)
        ttsQueueRef.current = { utteranceId: payload.utteranceId, segments: [], nextIndex: 0, finalized: false }
        setBubblePayload(null)
      }

      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== payload.utteranceId) return

      if (payload.segments?.length) current.segments.push(...payload.segments)
      startQueueIfNeeded()
    })

    const unsubFinalize = api.onTtsFinalize((utteranceId) => {
      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== utteranceId) return
      current.finalized = true
      startQueueIfNeeded()
    })

    return () => {
      unsubEnqueue()
      unsubFinalize()
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onTtsStopAll(() => {
      const current = ttsQueueRef.current
      if (current) {
        api.reportTtsUtteranceEnded({ utteranceId: current.utteranceId })
      }

      ttsQueueRef.current = null
      ttsQueueRunningRef.current = false
      ttsPlayerRef.current?.stop()
      setMouthOpen(0)
      setBubblePayload(null)
    })
  }, [api])

  // Lip sync: use analyser level to drive mouth openness
  useEffect(() => {
    let raf = 0

    const tick = () => {
      const player = ttsPlayerRef.current
      const level = player ? player.getLevel() : 0
      const target = Math.max(0, Math.min(1.25, level * 9.5))

      setMouthOpen((prev) => {
        const next = prev * 0.7 + target * 0.3
        return Math.abs(next - prev) < 0.01 ? prev : next
      })

      raf = window.requestAnimationFrame(tick)
    }

    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const bubbleSettings = settings?.bubble
  const taskPanelX = settings?.taskPanel?.positionX ?? 50
  const taskPanelY = settings?.taskPanel?.positionY ?? 78
  const visibleTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled')

  // Get model URL directly from settings
  const modelJsonUrl = settings?.live2dModelFile ?? '/live2d/Haru/Haru.model3.json'

  // 与 Live2DView 内的模型摆放保持一致的近似命中（用于拖拽/右键判断）
  const isPointOverLive2D = (clientX: number, clientY: number) => {
    if (!containerRef.current) return false
    const rect = containerRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    const centerX = rect.width / 2
    const centerY = rect.height / 2 + rect.height * 0.06
    const radiusX = rect.width * 0.42
    const radiusY = rect.height * 0.48

    const normalizedX = (x - centerX) / radiusX
    const normalizedY = (y - centerY) / radiusY
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (e.button === 0 && isOverModel.current) {
      // Left click on model - start drag
      isDragging.current = true
      clickStartTime.current = Date.now()
      api?.startDrag()
    }
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    if (e.button === 0 && isDragging.current) {
      isDragging.current = false
      api?.stopDrag()

      // Check if it was a click (not a drag) - less than 200ms
        const clickDuration = Date.now() - clickStartTime.current
        if (clickDuration < 200 && bubbleSettings?.showOnClick) {
          // Show random phrase from settings or defaults
          const phrases = bubbleSettings?.clickPhrases?.length > 0 ? bubbleSettings.clickPhrases : defaultPhrases
          const phrase = phrases[Math.floor(Math.random() * phrases.length)]
          setBubblePayload({ text: phrase, startAt: Date.now(), mode: 'typing' })
        }
      }
    }

  const handleContextMenu = (e: React.MouseEvent) => {
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (isOverModel.current) {
      e.preventDefault()
      api?.showContextMenu()
    }
  }

  // 主进程会根据鼠标位置动态切换窗口穿透；这里仅保留一个粗略命中用于决定是否允许拖拽/右键菜单。
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current || isDragging.current) return
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
  }

  const handleBubbleClose = useCallback(() => {
    setBubblePayload(null)
  }, [])

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        api?.stopDrag()
      }
    }
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [api])

  return (
    <div
      ref={containerRef}
      className="ndp-pet-root"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
    >
      <Live2DView modelJsonUrl={modelJsonUrl} scale={petScale} opacity={petOpacity} mouthOpen={mouthOpen} />
      {bubblePayload && (
        <SpeechBubble
          text={bubblePayload.text}
          startAt={bubblePayload.startAt}
          mode={bubblePayload.mode}
          style={bubbleSettings?.style ?? 'cute'}
          positionX={bubbleSettings?.positionX ?? 75}
          positionY={bubbleSettings?.positionY ?? 10}
          tailDirection={bubbleSettings?.tailDirection ?? 'down'}
          autoHideDelay={bubblePayload.autoHideDelay ?? (bubbleSettings?.autoHideDelay ?? 5000)}
          onClose={handleBubbleClose}
        />
      )}
      {visibleTasks.length > 0 && (
        <div
          className="ndp-task-panel"
          style={{ left: `${taskPanelX}%`, top: `${taskPanelY}%`, transform: 'translate(-50%, 0)' }}
          onMouseEnter={() => api?.setPetOverlayHover(true)}
          onMouseLeave={() => api?.setPetOverlayHover(false)}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <div className="ndp-task-panel-header">
            <div className="ndp-task-panel-title">任务进行中</div>
            <div className="ndp-task-panel-count">{Math.min(visibleTasks.length, 3)}/{visibleTasks.length}</div>
          </div>
          {visibleTasks.slice(0, 3).map((task) => {
            const currentStep = task.steps?.[Math.max(0, Math.min(task.currentStepIndex, task.steps.length - 1))]
            const lastStep = task.currentStepIndex > 0 ? task.steps?.[task.currentStepIndex - 1] : null
            const outputPreview = (lastStep?.output || '').trim()
            const progressText =
              task.steps?.length > 0
                ? `${Math.min(task.currentStepIndex + 1, task.steps.length)}/${task.steps.length}`
                : ''

            return (
              <div key={task.id} className="ndp-task-card">
                <div className="ndp-task-card-title">
                  <span className={`ndp-task-badge ndp-task-badge-${task.status}`}>{task.status}</span>
                  <span className="ndp-task-title-text">{task.title}</span>
                  {progressText && <span className="ndp-task-progress">{progressText}</span>}
                </div>
                {task.why && <div className="ndp-task-card-sub">{task.why}</div>}
                {currentStep?.title && <div className="ndp-task-card-sub">当前：{currentStep.title}</div>}
                {currentStep?.tool && <div className="ndp-task-card-sub">当前工具：{currentStep.tool}</div>}
                {task.toolsUsed?.length > 0 && (
                  <div className="ndp-task-card-sub">工具：{task.toolsUsed.join('、')}</div>
                )}
                {outputPreview && <div className="ndp-task-card-sub ndp-task-card-mono">输出：{outputPreview}</div>}
                {task.lastError && <div className="ndp-task-card-error">失败：{task.lastError}</div>}
                <div className="ndp-task-card-actions">
                  {task.status === 'running' && (
                    <button
                      className="ndp-task-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.pauseTask(task.id).catch((err) => console.error(err))}
                    >
                      暂停
                    </button>
                  )}
                  {task.status === 'paused' && (
                    <button
                      className="ndp-task-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.resumeTask(task.id).catch((err) => console.error(err))}
                    >
                      继续
                    </button>
                  )}
                  <button
                    className="ndp-task-btn ndp-task-btn-danger"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => void api?.cancelTask(task.id).catch((err) => console.error(err))}
                  >
                    终止
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChatWindow(props: { api: ReturnType<typeof getApi> }) {
  const { api } = props
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [lastRetrieveDebug, setLastRetrieveDebug] = useState<MemoryRetrieveResult['debug'] | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const isLoadingRef = useRef(false)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionName, setEditingSessionName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null)
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = useState('')
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const userAvatarInputRef = useRef<HTMLInputElement>(null)
  const assistantAvatarInputRef = useRef<HTMLInputElement>(null)
  const editingTextareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const ttsUtteranceMetaRef = useRef<
    Record<
      string,
      {
        sessionId: string
        assistantMessageId: string
        createdAt: number
        displayedSegments: number
        accumulated: string
        fallbackContent?: string
      }
    >
  >({})
  const asrClientRef = useRef<{
    ws: WebSocket
    mediaStream: MediaStream
    audioContext: AudioContext
    node: AudioNode
    sink: GainNode
    stopFeeder: () => void
    sampleRate: number
  } | null>(null)
  const asrStartingRef = useRef(false)
  const asrSendingRef = useRef(false)
  const asrSendQueueRef = useRef<string[]>([])
  const aiAbortRef = useRef<AbortController | null>(null)
  const plannerPendingRef = useRef(false)
  const taskOriginSessionRef = useRef<Map<string, string>>(new Map())
  const taskFinalAnnouncedRef = useRef<Set<string>>(new Set())

  const getActivePersonaId = useCallback((): string => {
    const pid = settingsRef.current?.activePersonaId
    return typeof pid === 'string' && pid.trim().length > 0 ? pid : 'default'
  }, [])

  const filterSessionsForPersona = useCallback(
    (all: ChatSessionSummary[]): ChatSessionSummary[] => all.filter((s) => s.personaId === getActivePersonaId()),
    [getActivePersonaId],
  )

  const autoExtractRunningRef = useRef<Record<string, boolean>>({})

  const runAutoExtractIfNeeded = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const settings = settingsRef.current
      const mem = settings?.memory
      if (!mem?.enabled) return
      if (!mem.autoExtractEnabled) return

      const updateSummary = (patch: Partial<ChatSessionSummary>) => {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)))
      }

      const formatAutoExtractError = (raw: string): { message: string; shouldAlert: boolean } => {
        const text = String(raw ?? '').trim()
        const lower = text.toLowerCase()
        const isContextTooLong =
          lower.includes('context_length') ||
          lower.includes('maximum context') ||
          (lower.includes('context') && lower.includes('length')) ||
          (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum')))

        if (!isContextTooLong) return { message: text || '自动提炼失败', shouldAlert: false }

        return {
          message: `上下文过长导致请求失败，可降低“提炼窗口”或右键“一键总结”。（原始错误：${text || 'unknown'}）`,
          shouldAlert: true,
        }
      }

      const every = clampIntValue(mem.autoExtractEveryEffectiveMessages, 20, 2, 2000)
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )
      const cooldownMs = clampIntValue(mem.autoExtractCooldownMs, 120000, 0, 3600000)

      if (autoExtractRunningRef.current[sessionId]) return
      autoExtractRunningRef.current[sessionId] = true

      let attemptAt = 0
      let effectiveCount = 0
      try {
        if (!settings?.ai) return

        const useCustomAi = !!mem.autoExtractUseCustomAi
        const base = settings.ai
        const extractAiSettings = useCustomAi
          ? {
              ...base,
              apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
              baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
              model: mem.autoExtractAiModel?.trim() || base.model,
              temperature:
                typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                  ? mem.autoExtractAiTemperature
                  : base.temperature,
              maxTokens:
                typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                  ? mem.autoExtractAiMaxTokens
                  : base.maxTokens,
            }
          : base

        const ai = new AIService(extractAiSettings)

        const session = await api.getChatSession(sessionId)
        attemptAt = Date.now()
        const lastRunAt = clampIntValue(session.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
        if (cooldownMs > 0 && attemptAt - lastRunAt < cooldownMs) return
        const effective = collapseAssistantRuns(session.messages)
        effectiveCount = effective.length
        const cursor = clampIntValue(session.autoExtractCursor ?? 0, 0, 0, 1_000_000)
        const delta = effectiveCount - cursor
        if (delta < every) return
        if (effectiveCount < 4) return

        const tail = sliceTail(effective, maxEffective)
        const conversation = tail
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
          .join('\n\n')
          .trim()
        if (!conversation) return

        const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。

规则：
1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。
2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。
3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。
4) 如果没有值得记的内容，返回空数组 []。
5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。

输出格式：
[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]

说明：
- scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

        const res = await ai.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
        ])
        if (res.error) {
          const errUi = formatAutoExtractError(res.error)
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          if (errUi.shouldAlert) window.alert(errUi.message)
          return
        }

        const parseJsonArray = (text: string): unknown[] | null => {
          const cleaned = (text ?? '').trim()
          if (!cleaned) return null
          try {
            const parsed = JSON.parse(cleaned)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            const start = cleaned.indexOf('[')
            const end = cleaned.lastIndexOf(']')
            if (start < 0 || end < 0 || end <= start) return null
            const slice = cleaned.slice(start, end + 1)
            try {
              const parsed = JSON.parse(slice)
              return Array.isArray(parsed) ? parsed : null
            } catch {
              return null
            }
          }
        }

        const arr = parseJsonArray(res.content)
        if (!arr) {
          const lastError = '自动提炼失败：无法解析模型输出（不是 JSON 数组）'
          await api.setChatAutoExtractMeta(sessionId, {
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          updateSummary({
            autoExtractCursor: effectiveCount,
            autoExtractLastRunAt: attemptAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: lastError,
          })
          return
        }

        const uniq = new Set<string>()
        const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue
          const obj = it as Record<string, unknown>
          const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
          const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
          const content = typeof obj.content === 'string' ? obj.content.trim() : ''
          if (!content) continue
          const normalized = content.replace(/\s+/g, ' ').trim()
          if (!normalized) continue
          if (normalized.length > 140) continue
          if (uniq.has(normalized)) continue
          uniq.add(normalized)
          items.push({ scope, content: normalized })
        }

        // 即使返回空数组，也推进游标，避免同一段对话被重复“空提炼”
        for (const it of items) {
          const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
            ? (consoleSettings.personaId || session.personaId || 'default')
            : (session.personaId || 'default')
          const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'
          const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
          await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
        }
        await api.setChatAutoExtractMeta(sessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
        updateSummary({
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: items.length,
          autoExtractLastError: '',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[AutoExtract] Failed:', err)
        const errUi = formatAutoExtractError(msg)
        try {
          const nextLastRunAt = attemptAt || Date.now()
          await api.setChatAutoExtractMeta(sessionId, {
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
          updateSummary({
            ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
            autoExtractLastRunAt: nextLastRunAt,
            autoExtractLastWriteCount: 0,
            autoExtractLastError: errUi.message,
          })
        } catch (_) {
          /* ignore */
        }
        if (errUi.shouldAlert) window.alert(errUi.message)
      } finally {
        autoExtractRunningRef.current[sessionId] = false
      }
    },
    [api],
  )

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    if (!api) return

    const unsubSegmentStarted = api.onTtsSegmentStarted((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (!meta) return

      const text = (payload.text ?? '').trim()
      if (!text) return

      const next = meta.accumulated ? `${meta.accumulated}\n${text}` : text
      meta.accumulated = next
      meta.displayedSegments += 1

      if (meta.sessionId === currentSessionId) {
        setMessages((prevMsgs) =>
          prevMsgs.map((m) => (m.id === meta.assistantMessageId ? { ...m, content: next } : m)),
        )
      }
      api.updateChatMessage(meta.sessionId, meta.assistantMessageId, next).catch(() => undefined)
    })

    const unsubUtteranceFailed = api.onTtsUtteranceFailed((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        const createId = () => {
          if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID()
          }
          return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        }

        const fallback = meta.fallbackContent?.trim() ?? ''
        const content = meta.displayedSegments === 0 && fallback.length > 0 ? fallback : `[错误] ${payload.error}`

        const msg: ChatMessageRecord = {
          id: createId(),
          role: 'assistant',
          content,
          createdAt: Date.now(),
        }

        if (meta.sessionId === currentSessionId) {
          setMessages((prevMsgs) => [...prevMsgs, msg])
        }
        api.addChatMessage(meta.sessionId, msg).catch(() => undefined)

        delete ttsUtteranceMetaRef.current[payload.utteranceId]
      }
      setError(payload.error)
    })

    const unsubUtteranceEnded = api.onTtsUtteranceEnded((payload) => {
      const meta = ttsUtteranceMetaRef.current[payload.utteranceId]
      delete ttsUtteranceMetaRef.current[payload.utteranceId]
      if (meta) {
        // 兜底：如果没有收到任何 segmentStarted，但模型有 fallbackContent，则把最终内容写回同一条 assistant 消息
        if (meta.displayedSegments === 0 && !meta.accumulated && (meta.fallbackContent?.trim() ?? '').length > 0) {
          const content = meta.fallbackContent!.trim()
          if (meta.sessionId === currentSessionId) {
            setMessages((prevMsgs) =>
              prevMsgs.map((m) => (m.id === meta.assistantMessageId ? { ...m, content } : m)),
            )
          }
          api.updateChatMessage(meta.sessionId, meta.assistantMessageId, content).catch(() => undefined)
        }
      }
      const sessionId = meta?.sessionId
      if (sessionId) {
        void runAutoExtractIfNeeded(sessionId)
      }
    })

    return () => {
      unsubSegmentStarted()
      unsubUtteranceFailed()
      unsubUtteranceEnded()
    }
  }, [api, currentSessionId, runAutoExtractIfNeeded])

  // Load settings
  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  useEffect(() => {
    if (!api) return
    const pid = settings?.activePersonaId?.trim() || 'default'
    api
      .getPersona(pid)
      .then((p) => setCurrentPersona(p))
      .catch(() => setCurrentPersona(null))
  }, [api, settings?.activePersonaId])

  // Load sessions and current messages
  useEffect(() => {
    if (!api) return

    let cancelled = false
    ;(async () => {
      const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
      if (cancelled) return

      const filtered = filterSessionsForPersona(allSessions)
      setSessions(filtered)

      // 当前会话可能属于其它人设：自动切到本人人设的最新会话（或创建一个）
      let nextSessionId =
        filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null)

      if (!nextSessionId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextSessionId = created.id
      } else if (nextSessionId !== currentSessionId) {
        await api.setCurrentChatSession(nextSessionId)
      }

      setCurrentSessionId(nextSessionId)

      const session = await api.getChatSession(nextSessionId ?? undefined)
      if (cancelled) return
      setMessages(session.messages)
    })().catch((err) => console.error(err))

    return () => {
      cancelled = true
    }
  }, [api, filterSessionsForPersona, getActivePersonaId, settings?.activePersonaId])

  // Initialize AI service and set model info when settings change
  useEffect(() => {
    if (!settings?.ai) return
    getAIService(settings.ai)

    // Load model metadata and set to AI service
    const modelFile = settings.live2dModelFile
    if (modelFile) {
      parseModelMetadata(modelFile).then((metadata) => {
        const expressions = metadata.expressions?.map((e) => e.name) || []
        const motions = metadata.motionGroups?.map((g) => g.name) || []
        setModelInfoToAIService(expressions, motions)
      })
    }
  }, [settings?.ai, settings?.live2dModelFile])

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )

  useEffect(() => {
    plannerPendingRef.current = false
  }, [currentSessionId])

  const memEnabled = settings?.memory?.enabled ?? true
  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const captureEnabled = currentPersona?.captureEnabled ?? true
  const retrieveEnabled = currentPersona?.retrieveEnabled ?? true
  const plannerEnabled = settings?.orchestrator?.plannerEnabled ?? false
  const plannerMode = settings?.orchestrator?.plannerMode ?? 'auto'

  const effectiveCountUi = useMemo(() => collapseAssistantRuns(messages).length, [messages])
  const cursorUi = clampIntValue(currentSession?.autoExtractCursor ?? 0, 0, 0, 1_000_000)
  const everyUi = clampIntValue(settings?.memory?.autoExtractEveryEffectiveMessages, 20, 2, 2000)
  const deltaUi = Math.max(0, effectiveCountUi - cursorUi)
  const remainingUi = memEnabled && autoExtractEnabled ? Math.max(0, everyUi - deltaUi) : 0

  const lastRunAtUi = clampIntValue(currentSession?.autoExtractLastRunAt ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
  const lastWriteCountUi = clampIntValue(currentSession?.autoExtractLastWriteCount ?? 0, 0, 0, 1_000_000)
  const lastErrorUi = (currentSession?.autoExtractLastError ?? '').trim()
  const lastErrorPreviewUi = lastErrorUi.length > 120 ? `${lastErrorUi.slice(0, 120)}…` : lastErrorUi

  const retrieveUi = useMemo(() => {
    if (!memEnabled || !retrieveEnabled) return { text: '-', title: '召回已关闭' }
    if (!lastRetrieveDebug) return { text: '-', title: '尚无召回记录（请先发送一条消息触发检索）' }

    const mapLayer = (l: NonNullable<MemoryRetrieveResult['debug']>['layers'][number]) => {
      if (l === 'timeRange') return 'TIME'
      if (l === 'fts') return 'FTS'
      if (l === 'like') return 'LIKE'
      if (l === 'tag') return 'TAG'
      if (l === 'kg') return 'KG'
      if (l === 'vector') return 'VEC'
      return 'NONE'
    }

    const layers = (lastRetrieveDebug.layers ?? []).map(mapLayer).join('+') || '-'
    const c = lastRetrieveDebug.counts
    const titleParts: string[] = []
    titleParts.push(`层级：${layers}`)
    titleParts.push(
      `命中：TIME=${c?.timeRange ?? 0} FTS=${c?.fts ?? 0} LIKE=${c?.like ?? 0} TAG=${c?.tag ?? 0} KG=${c?.kg ?? 0} VEC=${c?.vector ?? 0}`,
    )
    if (lastRetrieveDebug.tag) {
      titleParts.push(
        `Tag：query=${lastRetrieveDebug.tag.queryTags} matched=${lastRetrieveDebug.tag.matchedTags} expanded=${lastRetrieveDebug.tag.expandedTags}`,
      )
    }
    if (lastRetrieveDebug.vector) {
      const v = lastRetrieveDebug.vector
      const extra = [
        `enabled=${v.enabled ? '1' : '0'}`,
        `attempted=${v.attempted ? '1' : '0'}`,
        v.reason ? `reason=${v.reason}` : '',
        v.error ? `error=${v.error}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      titleParts.push(`向量：${extra}`)
    }
    titleParts.push(`耗时：${lastRetrieveDebug.tookMs}ms`)
    return { text: layers, title: titleParts.join('\n') }
  }, [lastRetrieveDebug, memEnabled, retrieveEnabled])

  const toggleCaptureEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { captureEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleRetrieveEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        const pid = settingsRef.current?.activePersonaId?.trim() || 'default'
        const p = await api.updatePersona(pid, { retrieveEnabled: enabled })
        setCurrentPersona(p)
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleAutoExtractEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setMemorySettings({ autoExtractEnabled: enabled })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const toggleTaskPlannerEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ plannerEnabled: enabled })
        if (!enabled) plannerPendingRef.current = false
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const setTaskPlannerMode = useCallback(
    async (mode: 'auto' | 'always') => {
      if (!api) return
      try {
        await api.setOrchestratorSettings({ plannerMode: mode })
      } catch (err) {
        console.error(err)
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [api],
  )

  const newMessageId = useCallback(() => {
    if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }, [])

  // 任务完成/失败后，把结果回写到对应会话里（仅对 planner 创建的任务生效）
  useEffect(() => {
    if (!api) return

    const off = api.onTasksChanged((payload) => {
      for (const t of payload.items ?? []) {
        const sessionId = taskOriginSessionRef.current.get(t.id)
        if (!sessionId) continue
        if (taskFinalAnnouncedRef.current.has(t.id)) continue
        if (t.status !== 'done' && t.status !== 'failed' && t.status !== 'canceled') continue

        taskFinalAnnouncedRef.current.add(t.id)
        taskOriginSessionRef.current.delete(t.id)

        const content = formatTaskFinalMessage(t)
        const msg: ChatMessageRecord = { id: newMessageId(), role: 'assistant', content, createdAt: Date.now() }

        if (sessionId === currentSessionId) {
          setMessages((prev) => [...prev, msg])
        }
        api.addChatMessage(sessionId, msg).catch(() => undefined)

        // 低打扰：只在失败时冒泡提示
        if (t.status === 'failed' && sessionId === currentSessionId && content) {
          api.sendBubbleMessage(content)
        }
      }
    })

    return () => off()
  }, [api, currentSessionId, newMessageId])

  const closeOverlays = useCallback(() => {
    setContextMenu(null)
    setSessionContextMenu(null)
    setShowSessionList(false)
  }, [])

  const readAvatarFile = useCallback((file: File, onLoaded: (dataUrl: string) => void) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 2 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => onLoaded(String(reader.result || ''))
    reader.readAsDataURL(file)
  }, [])

  const readChatImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 5 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => setPendingImage(String(reader.result || ''))
    reader.readAsDataURL(file)
  }, [])

  const canUseVision = settings?.ai?.enableVision ?? false

  const estimateTokensFromText = useCallback((text: string): number => {
    const cleaned = (text ?? '').trim()
    if (!cleaned) return 0
    return Math.max(1, Math.ceil(cleaned.length / 4))
  }, [])

  const estimateTokensForChatMessage = useCallback(
    (m: ChatMessage): number => {
      if (!m) return 0
      if (typeof m.content === 'string') return estimateTokensFromText(m.content)

      let total = 0
      for (const part of m.content) {
        if (part.type === 'text') total += estimateTokensFromText(part.text)
        else total += 800 // 图片大致占用（粗略估计）
      }
      return total
    },
    [estimateTokensFromText],
  )

  const trimChatHistoryToMaxContext = useCallback(
    (history: ChatMessage[], systemAddon: string): { history: ChatMessage[]; trimmedCount: number } => {
      const ai = settingsRef.current?.ai
      const maxContextTokensRaw = ai?.maxContextTokens ?? 128000
      const maxContextTokens = Math.max(2048, Math.trunc(Number.isFinite(maxContextTokensRaw) ? maxContextTokensRaw : 128000))

      const maxTokensRaw = ai?.maxTokens ?? 2048
      const outputReserve = Math.max(512, Math.min(8192, Math.trunc(Number.isFinite(maxTokensRaw) ? maxTokensRaw : 2048)))

      const systemPromptTokens = estimateTokensFromText(ai?.systemPrompt ?? '')
      const addonTokens = estimateTokensFromText(systemAddon ?? '')

      let budget = maxContextTokens - outputReserve - systemPromptTokens - addonTokens
      if (!Number.isFinite(budget) || budget < 256) budget = 256

      const kept: ChatMessage[] = []
      let total = 0
      for (let i = history.length - 1; i >= 0; i--) {
        const cost = estimateTokensForChatMessage(history[i])
        if (kept.length > 0 && total + cost > budget) break
        kept.push(history[i])
        total += cost
      }
      kept.reverse()
      return { history: kept, trimmedCount: Math.max(0, history.length - kept.length) }
    },
    [estimateTokensForChatMessage, estimateTokensFromText],
  )

  const formatAiErrorForUser = useCallback((raw: string): { message: string; shouldAlert: boolean } => {
    const text = String(raw ?? '').trim()
    const lower = text.toLowerCase()
    const isContextTooLong =
      lower.includes('context_length') ||
      lower.includes('maximum context') ||
      (lower.includes('context') && lower.includes('length')) ||
      (lower.includes('token') && (lower.includes('limit') || lower.includes('maximum'))) ||
      text.includes('上下文') ||
      text.includes('长度超出') ||
      text.includes('超出上下文')

    if (!isContextTooLong) return { message: text || '未知错误', shouldAlert: false }

    return {
      message: `上下文过长导致请求失败，可右键“一键总结”或清空对话后重试。（原始错误：${text || 'unknown'}）`,
      shouldAlert: true,
    }
  }, [])

  const pickAvatar = useCallback(
    (role: 'user' | 'assistant') => {
      if (role === 'user') userAvatarInputRef.current?.click()
      else assistantAvatarInputRef.current?.click()
    },
    [],
  )

  const refreshSessions = useCallback(async () => {
    if (!api) return
    const activePersonaId = getActivePersonaId()
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    let filtered = filterSessionsForPersona(allSessions)

    // 如果当前人设完全没有会话，则自动创建一个，避免出现“没有 currentSessionId 导致无法清空/发送”的卡死状态
    if (filtered.length === 0) {
      const created = await api.createChatSession(undefined, activePersonaId)
      const { sessions: again, currentSessionId: cur2 } = await api.listChatSessions()
      filtered = filterSessionsForPersona(again)
      setSessions(filtered)
      setCurrentSessionId(filtered.some((s) => s.id === cur2) ? cur2 : created.id)
      return
    }

    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : (filtered[0]?.id ?? null))
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const interrupt = useCallback(
    (opts?: { stopTts?: boolean }) => {
      try {
        aiAbortRef.current?.abort()
      } catch (_) {
        /* ignore */
      }
      aiAbortRef.current = null

      if (opts?.stopTts !== false) {
        try {
          api?.stopTtsAll()
        } catch (_) {
          /* ignore */
        }
      }

      isLoadingRef.current = false
      setIsLoading(false)
    },
    [api],
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        try {
          api?.stopTtsAll()
        } catch (_) {
          /* ignore */
        }
        if (isLoadingRef.current) {
          interrupt()
          return
        }
        closeOverlays()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [api, closeOverlays, interrupt])

  useEffect(() => {
    if (!editingMessageId) return
    const el = editingTextareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editingMessageId, editingMessageContent])

  const send = useCallback(async (override?: { text?: string; image?: string | null; source?: 'manual' | 'asr' }) => {
    const source = override?.source ?? 'manual'
    const text = (override?.text ?? input).trim()
    const image = source === 'manual' ? (override?.image ?? pendingImage) : (override?.image ?? null)
    if (!api || !currentSessionId) return

    // 发送新消息前先停止正在播放的 TTS/气泡（作为“打断”）
    try {
      api.stopTtsAll()
    } catch (_) {
      /* ignore */
    }

    if (isLoadingRef.current) {
      interrupt()
      if (!text && !image) return
    } else {
      if (!text && !image) return
    }

    const aiService = getAIService()
    if (!aiService) {
      setError('AI 服务未初始化，请先配置 AI 设置')
      return
    }

    if (image && !canUseVision) {
      setError('当前未启用识图能力，无法发送图片（请在设置 -> AI 设置中开启）')
      return
    }

    // Add user message
    const userMessage: ChatMessageRecord = {
      id: newMessageId(),
      role: 'user',
      content: text || '[图片]',
      image: image || undefined,
      createdAt: Date.now(),
    }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    if (source === 'manual') {
      setInput('')
      setPendingImage(null)
    }
    setError(null)
    isLoadingRef.current = true
    setIsLoading(true)
    const abort = new AbortController()
    aiAbortRef.current = abort

    try {
      // Build chat history for context
      let chatHistory: ChatMessage[] = nextMessages.map((m) => {
        if (m.role !== 'user') return { role: 'assistant', content: m.content }

        if (m.image && canUseVision) {
          const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
          const text = m.content === '[图片]' ? '' : m.content
          if (text.trim().length > 0) parts.push({ type: 'text', text })
          parts.push({ type: 'image_url', image_url: { url: m.image } })
          return { role: 'user', content: parts }
        }

        const plain = m.content.trim().length > 0 ? m.content : '[图片]'
        return { role: 'user', content: plain }
      })

      await api.addChatMessage(currentSessionId, userMessage)

      // M4：对话 → 任务规划器（LLM Planner）→ TaskService
      const orch = settingsRef.current?.orchestrator
      const plannerEnabledNow = orch?.plannerEnabled ?? false
      const plannerModeNow = orch?.plannerMode ?? 'auto'
      const pendingBefore = plannerPendingRef.current
      const shouldTryPlanner =
        plannerEnabledNow &&
        (plannerModeNow === 'always' || pendingBefore || looksLikeToolTaskRequest(text))

      if (shouldTryPlanner && (text ?? '').trim().length > 0) {
        try {
          const plannerHistory: ChatMessage[] = sliceTail(nextMessages, 12).map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          }))

          const planRes = await aiService.chat(
            [{ role: 'system', content: buildPlannerSystemPrompt() }, ...plannerHistory],
            { signal: abort.signal },
          )

          if (planRes.error) {
            if (planRes.error === ABORTED_ERROR) return
          } else {
            const decision = parsePlannerDecision(planRes.content)

            if (decision?.type === 'need_info') {
              plannerPendingRef.current = true
              const assistantMessage: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: decision.assistantReply,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              if (assistantMessage.content) api.sendBubbleMessage(assistantMessage.content)
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'create_task') {
              const runnable = (decision.task.steps ?? []).some(
                (s) => typeof s.tool === 'string' && TASK_PLANNER_TOOLS.includes(s.tool as (typeof TASK_PLANNER_TOOLS)[number]),
              )
              if (!runnable) throw new Error('规划器未生成可执行步骤（没有可用 tool）')

              const inferQueue = (): TaskCreateArgs['queue'] => {
                if (decision.task.queue) return decision.task.queue
                const tools = (decision.task.steps ?? []).map((s) => (typeof s.tool === 'string' ? s.tool : ''))
                if (tools.some((t) => t.startsWith('browser.'))) return 'browser'
                if (tools.some((t) => t.startsWith('cli.'))) return 'cli'
                if (tools.some((t) => t.startsWith('file.'))) return 'file'
                if (tools.some((t) => t.startsWith('llm.'))) return 'chat'
                return 'other'
              }

              const taskArgs: TaskCreateArgs = { ...decision.task, queue: inferQueue() }
              const created = await api.createTask(taskArgs)
              taskOriginSessionRef.current.set(created.id, currentSessionId)
              taskFinalAnnouncedRef.current.delete(created.id)

              plannerPendingRef.current = false
              const replyBase = decision.assistantReply || `好的，我开始执行：${created.title}`
              const reply = replyBase.replace(/{{\s*task\.id\s*}}/g, created.id).trim() || `已创建任务：${created.title}`
              const assistantMessage: ChatMessageRecord = {
                id: newMessageId(),
                role: 'assistant',
                content: reply,
                createdAt: Date.now(),
              }
              setMessages((prev) => [...prev, assistantMessage])
              await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
              if (assistantMessage.content) api.sendBubbleMessage(assistantMessage.content)
              void runAutoExtractIfNeeded(currentSessionId)
              return
            }

            if (decision?.type === 'chat') {
              plannerPendingRef.current = false
              const shouldUsePlannerChatReply = plannerModeNow === 'always' || pendingBefore
              if (shouldUsePlannerChatReply && decision.assistantReply) {
                const assistantMessage: ChatMessageRecord = {
                  id: newMessageId(),
                  role: 'assistant',
                  content: decision.assistantReply,
                  createdAt: Date.now(),
                }
                setMessages((prev) => [...prev, assistantMessage])
                await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
                if (assistantMessage.content) api.sendBubbleMessage(assistantMessage.content)
                void runAutoExtractIfNeeded(currentSessionId)
                return
              }
            }
          }
        } catch (err) {
          console.error('[Planner] failed:', err)
        }
      }

      let systemAddon = ''
      setLastRetrieveDebug(null)
      try {
        const memEnabled = settingsRef.current?.memory?.enabled ?? true
        if (!memEnabled) throw new Error('memory disabled')
        const queryText = (text ?? '').trim()
        if (queryText.length > 0) {
          const personaId = getActivePersonaId()
          const res = await api.retrieveMemory({
            personaId,
            query: queryText,
            limit: 12,
            maxChars: 3200,
            includeShared: settingsRef.current?.memory?.includeSharedOnRetrieve ?? true,
          })
          systemAddon = res.addon?.trim() ?? ''
          setLastRetrieveDebug(res.debug ?? null)
        }
      } catch (_) {
        systemAddon = ''
        setLastRetrieveDebug(null)
      }

      {
        const trimmed = trimChatHistoryToMaxContext(chatHistory, systemAddon)
        chatHistory = trimmed.history
        if (trimmed.trimmedCount > 0) {
          setError(
            `提示：对话上下文过长，已自动截断为最近 ${chatHistory.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`,
          )
        }
      }

      const enableChatStreaming = settingsRef.current?.ai?.enableChatStreaming ?? false
      const ttsSegmented = (settingsRef.current?.tts?.enabled ?? false) && (settingsRef.current?.tts?.segmented ?? false)

      if (ttsSegmented) {
        const utteranceId = newMessageId()
        const createdAt = Date.now()
        const assistantMessage: ChatMessageRecord = { id: utteranceId, role: 'assistant', content: '', createdAt }
        ttsUtteranceMetaRef.current[utteranceId] = {
          sessionId: currentSessionId,
          assistantMessageId: utteranceId,
          createdAt,
          displayedSegments: 0,
          accumulated: '',
        }

        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)

        api.enqueueTtsUtterance({ utteranceId, mode: 'replace', segments: [] })

        try {
          if (enableChatStreaming) {
            const segmenter = createStreamingSentenceSegmenter()
            let sentSegments = 0

            const response = await aiService.chatStream(chatHistory, {
              signal: abort.signal,
              systemAddon,
              onDelta: (delta) => {
                const segs = segmenter.push(delta)
                if (!segs.length) return
                sentSegments += segs.length
                api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: segs })
              },
            })

            if (response.error) {
              if (response.error === ABORTED_ERROR) {
                api.finalizeTtsUtterance(utteranceId)
                return
              }
              const errUi = formatAiErrorForUser(response.error)
              setError(errUi.message)
              if (errUi.shouldAlert) window.alert(errUi.message)
              const nextContent = `[错误] ${response.error}`
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
              await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
              api.finalizeTtsUtterance(utteranceId)
              return
            }

            if (ttsUtteranceMetaRef.current[utteranceId]) {
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = response.content
            }

            const tail = segmenter.flush()
            if (tail.length) {
              sentSegments += tail.length
              api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: tail })
            }

            if (sentSegments === 0 && response.content) {
              const segs = splitTextIntoSegments(response.content)
              if (segs.length) {
                sentSegments += segs.length
                api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: segs })
              }
            }

            api.finalizeTtsUtterance(utteranceId)
            if (response.expression) api.triggerExpression(response.expression)
            if (response.motion) api.triggerMotion(response.motion, 0)
            return
          }

          const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              api.finalizeTtsUtterance(utteranceId)
              return
            }
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            const nextContent = `[错误] ${response.error}`
            setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
            await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
            api.finalizeTtsUtterance(utteranceId)
            return
          }

          if (ttsUtteranceMetaRef.current[utteranceId]) {
            ttsUtteranceMetaRef.current[utteranceId].fallbackContent = response.content
          }

          const segs = splitTextIntoSegments(response.content)
          api.enqueueTtsUtterance({
            utteranceId,
            mode: 'append',
            segments: segs.length ? segs : [response.content],
          })
          api.finalizeTtsUtterance(utteranceId)

          if (response.expression) api.triggerExpression(response.expression)
          if (response.motion) api.triggerMotion(response.motion, 0)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
          const nextContent = `[错误] ${msg}`
          setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
          await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
          api.finalizeTtsUtterance(utteranceId)
        }

        return
      }

      if (enableChatStreaming) {
        const assistantId = newMessageId()
        let created = false
        const createdAt = Date.now()
        let acc = ''
        let pending = ''
        let raf = 0

        const ensureMessageCreated = () => {
          if (created) return
          created = true
          const assistantMessage: ChatMessageRecord = {
            id: assistantId,
            role: 'assistant',
            content: '',
            createdAt,
          }
          setMessages((prev) => [...prev, assistantMessage])
          api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
        }

        const flush = () => {
          if (!pending) return
          acc += pending
          pending = ''
          if (!created) ensureMessageCreated()
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)))
        }

        const scheduleFlush = () => {
          if (raf) return
          raf = window.requestAnimationFrame(() => {
            raf = 0
            flush()
          })
        }

        const response = await aiService.chatStream(chatHistory, {
          signal: abort.signal,
          systemAddon,
          onDelta: (delta) => {
            pending += delta
            scheduleFlush()
          },
        })

        if (raf) {
          window.cancelAnimationFrame(raf)
          raf = 0
        }
        flush()

        if (response.error) {
          if (response.error === ABORTED_ERROR) {
            // 被打断：不写入错误信息，直接结束
            return
          }
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const nextContent = `[错误] ${response.error}`
          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }
          return
        }

        if (created) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: response.content } : m)))
          await api.updateChatMessage(currentSessionId, assistantId, response.content).catch(() => undefined)
        } else {
          const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: response.content, createdAt }
          setMessages((prev) => [...prev, msg])
          await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
        }

        if (response.expression) api.triggerExpression(response.expression)
        if (response.motion) api.triggerMotion(response.motion, 0)
        if (response.content) api.sendBubbleMessage(response.content)
        void runAutoExtractIfNeeded(currentSessionId)
        return
      }

      const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })

      if (response.error) {
        if (response.error === ABORTED_ERROR) return
        const errUi = formatAiErrorForUser(response.error)
        setError(errUi.message)
        if (errUi.shouldAlert) window.alert(errUi.message)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${response.error}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)
        return
      }

      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage)

      if (response.expression) api.triggerExpression(response.expression)
      if (response.motion) api.triggerMotion(response.motion, 0)
      if (response.content) api.sendBubbleMessage(response.content)
      void runAutoExtractIfNeeded(currentSessionId)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
      const assistantMessage: ChatMessageRecord = {
        id: newMessageId(),
        role: 'assistant',
        content: `[错误] ${errorMessage}`,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMessage])
      await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
    } finally {
      if (aiAbortRef.current === abort) aiAbortRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      refreshSessions().catch(() => undefined)
    }
  }, [
    api,
    canUseVision,
    currentSessionId,
    getActivePersonaId,
    input,
    messages,
    newMessageId,
    pendingImage,
    refreshSessions,
    interrupt,
    runAutoExtractIfNeeded,
    trimChatHistoryToMaxContext,
    formatAiErrorForUser,
  ])

  const drainAsrQueue = useCallback(() => {
    if (asrSendingRef.current) return
    const next = asrSendQueueRef.current.shift()
    if (!next) return

    asrSendingRef.current = true
    void send({ text: next, image: null, source: 'asr' }).finally(() => {
      asrSendingRef.current = false
      drainAsrQueue()
    })
  }, [send])

  const handleAsrText = useCallback(
    (text: string) => {
      const cleaned = text.trim()
      if (!cleaned) return

      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return

      if (asr.autoSend) {
        asrSendQueueRef.current.push(cleaned)
        drainAsrQueue()
        return
      }

      setInput((prev) => {
        const base = prev.trim()
        if (!base) return cleaned
        return `${prev} ${cleaned}`
      })
    },
    [drainAsrQueue],
  )

  const stopAsr = useCallback(() => {
    const client = asrClientRef.current
    if (!client) return
    asrClientRef.current = null
    asrStartingRef.current = false

    try {
      client.stopFeeder()
    } catch (_) {
      /* ignore */
    }

    try {
      client.node.disconnect()
    } catch (_) {
      /* ignore */
    }

    try {
      client.sink.disconnect()
    } catch (_) {
      /* ignore */
    }

    try {
      client.audioContext.close()
    } catch (_) {
      /* ignore */
    }

    try {
      client.mediaStream.getTracks().forEach((t) => t.stop())
    } catch (_) {
      /* ignore */
    }

    try {
      client.ws.close()
    } catch (_) {
      /* ignore */
    }
  }, [])

  const sendAsrConfig = useCallback(() => {
    const client = asrClientRef.current
    if (!client) return
    if (client.ws.readyState !== WebSocket.OPEN) return

    const asr = settingsRef.current?.asr
    if (!asr) return

    client.ws.send(
      JSON.stringify({
        type: 'config',
        sampleRate: client.sampleRate,
        language: asr.language,
        useItn: asr.useItn,
        vadChunkMs: asr.vadChunkMs,
        maxEndSilenceMs: asr.maxEndSilenceMs,
        minSpeechMs: asr.minSpeechMs,
        maxSpeechMs: asr.maxSpeechMs,
        prerollMs: asr.prerollMs,
        postrollMs: asr.postrollMs,
        enableAgc: asr.enableAgc,
        agcTargetRms: asr.agcTargetRms,
        agcMaxGain: asr.agcMaxGain,
        debug: asr.debug,
      }),
    )
  }, [])

  const startAsr = useCallback(async () => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (asrClientRef.current) return
    if (asrStartingRef.current) return
    asrStartingRef.current = true

    try {
      if (!asr.wsUrl.trim()) {
        setError('ASR WebSocket 地址为空')
        return
      }

      const pickStream = async () => {
        const deviceId = (asr.micDeviceId || '').trim()
        const base: MediaTrackConstraints = {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }

        if (!deviceId) {
          return navigator.mediaDevices.getUserMedia({ audio: base })
        }

        // 优先用 exact；失败时尝试 ideal；再失败回退系统默认
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
        } catch (_e1) {
          try {
            return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { ideal: deviceId } } })
          } catch (_e2) {
            return navigator.mediaDevices.getUserMedia({ audio: base })
          }
        }
      }

      const mediaStream = await pickStream()

      // 使用系统默认采样率：音质更稳定；服务端会按 VAD 分块做批量重采样
      const audioContext = new AudioContext()
      const sampleRate = audioContext.sampleRate || 48000

      const source = audioContext.createMediaStreamSource(mediaStream)

      // 避免把麦克风音频直接输出到扬声器造成回声/啸叫，从而影响识别效果
      const sink = audioContext.createGain()
      sink.gain.value = 0
      sink.connect(audioContext.destination)

      const ws = new WebSocket(asr.wsUrl)
      ws.binaryType = 'arraybuffer'

      const bufferSize = 4096

      const sendPcm = (pcm: Float32Array) => {
        if (ws.readyState !== WebSocket.OPEN) return
        const copy = new Float32Array(pcm.length)
        copy.set(pcm)
        ws.send(copy.buffer)
      }

      // Electron/桌宠 UI 负载高时，ScriptProcessor(主线程)容易丢帧导致识别变差；
      // 优先使用 AudioWorklet(音频渲染线程)做采集缓冲，降低主线程抖动影响
      let node: AudioNode
      let stopFeeder: () => void

      const tryCreateWorklet = async () => {
        if (!audioContext.audioWorklet) return null

        const workletCode = `
class NdpPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${bufferSize});
    this._idx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      let off = 0;
      while (off < ch.length) {
        const take = Math.min(ch.length - off, this._buf.length - this._idx);
        this._buf.set(ch.subarray(off, off + take), this._idx);
        this._idx += take;
        off += take;
        if (this._idx >= this._buf.length) {
          this.port.postMessage(this._buf, [this._buf.buffer]);
          this._buf = new Float32Array(${bufferSize});
          this._idx = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ndp-pcm', NdpPcmProcessor);
`
        const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' }))
        try {
          await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
          URL.revokeObjectURL(blobUrl)
        }

        const workletNode = new AudioWorkletNode(audioContext, 'ndp-pcm', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        })

        workletNode.port.onmessage = (ev) => {
          const data = ev.data
          if (ws.readyState !== WebSocket.OPEN) return
          if (data instanceof Float32Array) {
            ws.send(data.buffer)
            return
          }
          if (data instanceof ArrayBuffer) {
            ws.send(data)
          }
        }

        return {
          node: workletNode as AudioNode,
          stop: () => {
            try {
              workletNode.port.onmessage = null
            } catch (_) {
              /* ignore */
            }
          },
        }
      }

      const worklet = await tryCreateWorklet()
      if (worklet) {
        node = worklet.node
        stopFeeder = worklet.stop
        source.connect(node)
        node.connect(sink)
      } else {
        const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0)
          sendPcm(input)
        }
        node = processor
        stopFeeder = () => {
          try {
            processor.onaudioprocess = null
          } catch (_) {
            /* ignore */
          }
        }
        source.connect(processor)
        processor.connect(sink)
      }

      asrClientRef.current = { ws, mediaStream, audioContext, node, sink, stopFeeder, sampleRate }

      ws.onopen = () => {
        sendAsrConfig()
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || ''))
          if (msg?.type === 'result') {
            handleAsrText(String(msg.text || ''))
          }
        } catch (_) {
          // ignore
        }
      }
      ws.onerror = () => {
        if (settingsRef.current?.asr?.debug) console.error('[ASR] WebSocket error')
      }
    } finally {
      asrStartingRef.current = false
    }
  }, [handleAsrText, sendAsrConfig])

  const asrEnabled = settings?.asr?.enabled ?? false
  const asrWsUrl = settings?.asr?.wsUrl ?? ''
  const asrMicDeviceId = settings?.asr?.micDeviceId ?? ''
  useEffect(() => {
    if (!asrEnabled) {
      asrSendQueueRef.current = []
      stopAsr()
      return
    }
    void startAsr().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`ASR 启动失败：${msg}`)
      stopAsr()
    })
    return () => stopAsr()
  }, [asrEnabled, asrWsUrl, asrMicDeviceId, startAsr, stopAsr])

  const asrConfigKey = useMemo(() => {
    const asr = settings?.asr
    if (!asr) return ''
    return JSON.stringify({
      enabled: asr.enabled,
      wsUrl: asr.wsUrl,
      micDeviceId: asr.micDeviceId,
      language: asr.language,
      useItn: asr.useItn,
      autoSend: asr.autoSend,
      vadChunkMs: asr.vadChunkMs,
      maxEndSilenceMs: asr.maxEndSilenceMs,
      minSpeechMs: asr.minSpeechMs,
      maxSpeechMs: asr.maxSpeechMs,
      prerollMs: asr.prerollMs,
      postrollMs: asr.postrollMs,
      enableAgc: asr.enableAgc,
      agcTargetRms: asr.agcTargetRms,
      agcMaxGain: asr.agcMaxGain,
      debug: asr.debug,
    })
  }, [settings?.asr])

  useEffect(() => {
    if (!asrEnabled) return
    sendAsrConfig()
  }, [asrConfigKey, asrEnabled, sendAsrConfig])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const clearMessages = () => {
    if (!api) return
    setMessages([])
    setError(null)
    ;(async () => {
      const sid =
        currentSessionId ??
        (await api.listChatSessions().then((r) => r.currentSessionId).catch(() => '')) ??
        ''
      if (!sid) return
      await api.clearChatSession(sid)
      await refreshSessions()
    })().catch((err) => console.error(err))
  }

  const handleNewSession = useCallback(async () => {
    if (!api) return
    const session = await api.createChatSession(undefined, getActivePersonaId())
    const { sessions: allSessions, currentSessionId } = await api.listChatSessions()
    const filtered = filterSessionsForPersona(allSessions)
    setSessions(filtered)
    setCurrentSessionId(filtered.some((s) => s.id === currentSessionId) ? currentSessionId : session.id)
    setMessages(session.messages)
    setError(null)
    setShowSessionList(false)
  }, [api, filterSessionsForPersona, getActivePersonaId])

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      await api.setCurrentChatSession(sessionId)
      const session = await api.getChatSession(sessionId)
      setCurrentSessionId(sessionId)
      setMessages(session.messages)
      setError(null)
      setShowSessionList(false)
    },
    [api],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const result = await api.deleteChatSession(sessionId)
      const filtered = filterSessionsForPersona(result.sessions)
      setSessions(filtered)
      let nextId =
        filtered.some((s) => s.id === result.currentSessionId) ? result.currentSessionId : (filtered[0]?.id ?? null)
      if (!nextId) {
        const created = await api.createChatSession(undefined, getActivePersonaId())
        nextId = created.id
      }
      setCurrentSessionId(nextId)
      const session = await api.getChatSession(nextId)
      setMessages(session.messages)
      setError(null)
      setShowSessionList(false)
    },
    [api, filterSessionsForPersona, getActivePersonaId],
  )

  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      if (!api) return
      await api.renameChatSession(sessionId, name)
      const { sessions: allSessions } = await api.listChatSessions()
      setSessions(filterSessionsForPersona(allSessions))
      setEditingSessionId(null)
      setEditingSessionName('')
    },
    [api, filterSessionsForPersona],
  )

  const handleMessageContextMenu = useCallback((e: React.MouseEvent, messageId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setSessionContextMenu(null)
    setContextMenu({ messageId, x: e.clientX, y: e.clientY })
  }, [])

  const handleChatRootContextMenu = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    if (el.closest('.ndp-msg-row')) return
    if (el.closest('.ndp-session-list')) return
    if (el.closest('.ndp-context-menu')) return
    e.preventDefault()
    setContextMenu(null)
    setSessionContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const runQuickExtract = useCallback(async () => {
    if (!api) return
    if (!currentSessionId) return

    const settings = settingsRef.current
    const mem = settings?.memory
    if (!mem?.enabled) {
      window.alert('记忆功能已关闭，请先在设置中开启。')
      return
    }
    if (!settings?.ai) {
      window.alert('AI 服务未配置，请先在设置中配置 API Key。')
      return
    }

    if (autoExtractRunningRef.current[currentSessionId]) {
      window.alert('正在提炼中，请稍后再试。')
      return
    }
    autoExtractRunningRef.current[currentSessionId] = true

    let attemptAt = 0
    let effectiveCount = 0
    try {
      const consoleSettings = settings?.memoryConsole
      const maxEffective = clampIntValue(
        consoleSettings?.extractMaxMessages ?? mem.autoExtractMaxEffectiveMessages,
        60,
        6,
        2000,
      )

      const useCustomAi = !!mem.autoExtractUseCustomAi
      const base = settings.ai
      const extractAiSettings = useCustomAi
        ? {
            ...base,
            apiKey: mem.autoExtractAiApiKey?.trim() || base.apiKey,
            baseUrl: mem.autoExtractAiBaseUrl?.trim() || base.baseUrl,
            model: mem.autoExtractAiModel?.trim() || base.model,
            temperature:
              typeof mem.autoExtractAiTemperature === 'number' && Number.isFinite(mem.autoExtractAiTemperature)
                ? mem.autoExtractAiTemperature
                : base.temperature,
            maxTokens:
              typeof mem.autoExtractAiMaxTokens === 'number' && Number.isFinite(mem.autoExtractAiMaxTokens)
                ? mem.autoExtractAiMaxTokens
                : base.maxTokens,
          }
        : base

      const ai = new AIService(extractAiSettings)

      const session = await api.getChatSession(currentSessionId)
      attemptAt = Date.now()
      const effective = collapseAssistantRuns(session.messages)
      effectiveCount = effective.length
      if (effectiveCount < 4) {
        window.alert('对话内容太少，暂时不需要总结。')
        return
      }

      const tail = sliceTail(effective, maxEffective)
      const conversation = tail
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n\n')
        .trim()
      if (!conversation) {
        window.alert('对话内容为空，无法总结。')
        return
      }

      const systemPrompt = `你是“长期记忆提炼器”。你从对话中提炼“长期稳定、对未来有用”的记忆条目，并写入长期记忆库。
规则：1) 只提炼稳定事实/偏好/重要约束/长期目标/重要背景；不要记录一次性闲聊、情绪宣泄、无关客套、短期临时信息。2) 每条记忆必须“可复用、可验证、可执行”，避免含糊空话。3) 每条记忆使用简短中文（建议 15~80 字），不要超过 120 字。4) 如果没有值得记的内容，返回空数组 []。5) 输出必须是严格 JSON 数组，不要输出任何解释、代码块、或多余文本。
输出格式：[
  {"scope":"persona","content":"..."},
  {"scope":"shared","content":"..."}
]
说明：scope=persona 表示仅当前人设可用；shared 表示可跨人设共享。优先使用 persona。`

      const res = await ai.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请从以下对话中提炼长期记忆：\n\n${conversation}` },
      ])
      if (res.error) {
        const msg = `一键总结失败：${res.error}`
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const parseJsonArray = (text: string): unknown[] | null => {
        const cleaned = (text ?? '').trim()
        if (!cleaned) return null
        try {
          const parsed = JSON.parse(cleaned)
          return Array.isArray(parsed) ? parsed : null
        } catch {
          const start = cleaned.indexOf('[')
          const end = cleaned.lastIndexOf(']')
          if (start < 0 || end < 0 || end <= start) return null
          const slice = cleaned.slice(start, end + 1)
          try {
            const parsed = JSON.parse(slice)
            return Array.isArray(parsed) ? parsed : null
          } catch {
            return null
          }
        }
      }

      const arr = parseJsonArray(res.content)
      if (!arr) {
        const msg = '一键总结失败：无法解析模型输出（不是 JSON 数组）。'
        setError(msg)
        window.alert(msg)
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const uniq = new Set<string>()
      const items: Array<{ scope: 'persona' | 'shared'; content: string }> = []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        const obj = it as Record<string, unknown>
        const scopeRaw = typeof obj.scope === 'string' ? obj.scope.trim() : ''
        const scope: 'persona' | 'shared' = scopeRaw === 'shared' ? 'shared' : 'persona'
        const content = typeof obj.content === 'string' ? obj.content.trim() : ''
        if (!content) continue
        const normalized = content.replace(/\s+/g, ' ').trim()
        if (!normalized) continue
        if (normalized.length > 140) continue
        if (uniq.has(`${scope}::${normalized}`)) continue
        uniq.add(`${scope}::${normalized}`)
        items.push({ scope, content: normalized })
      }

      if (items.length === 0) {
        window.alert('模型没有返回可写入的长期记忆（空数组或无有效条目）。')
        await api.setChatAutoExtractMeta(currentSessionId, {
          autoExtractCursor: effectiveCount,
          autoExtractLastRunAt: attemptAt,
          autoExtractLastWriteCount: 0,
          autoExtractLastError: '',
        })
        refreshSessions().catch(() => undefined)
        return
      }

      const targetPersonaId = consoleSettings?.extractWriteToSelectedPersona
        ? (consoleSettings.personaId || session.personaId || 'default')
        : (session.personaId || 'default')
      const saveScopeMode = consoleSettings?.extractSaveScope ?? 'model'

      for (const it of items) {
        const scopeToSave = saveScopeMode === 'model' ? it.scope : saveScopeMode === 'shared' ? 'shared' : 'persona'
        await api.upsertManualMemory({ personaId: targetPersonaId, scope: scopeToSave, content: it.content, source: 'auto_extract' })
      }
      await api.setChatAutoExtractMeta(currentSessionId, {
        autoExtractCursor: effectiveCount,
        autoExtractLastRunAt: attemptAt,
        autoExtractLastWriteCount: items.length,
        autoExtractLastError: '',
      })
      refreshSessions().catch(() => undefined)
      setError(null)
      window.alert(`已写入 ${items.length} 条长期记忆。`)
    } catch (err) {
      const msg = `一键总结失败：${err instanceof Error ? err.message : String(err)}`
      console.error(err)
      setError(msg)
      window.alert(msg)
      try {
        await api.setChatAutoExtractMeta(currentSessionId, {
          ...(effectiveCount > 0 ? { autoExtractCursor: effectiveCount } : {}),
          autoExtractLastRunAt: attemptAt || Date.now(),
          autoExtractLastWriteCount: 0,
          autoExtractLastError: msg,
        })
        refreshSessions().catch(() => undefined)
      } catch (_) {
        /* ignore */
      }
    } finally {
      autoExtractRunningRef.current[currentSessionId] = false
      setSessionContextMenu(null)
    }
  }, [api, currentSessionId, refreshSessions])

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      setContextMenu(null)
      await api.deleteChatMessage(currentSessionId, messageId)
      await refreshSessions()
    },
    [api, currentSessionId, refreshSessions],
  )

  const handleStartEdit = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId)
      if (!msg) return
      setEditingMessageId(messageId)
      setEditingMessageContent(msg.content)
      setContextMenu(null)
    },
    [messages],
  )

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!api || !currentSessionId || !editingMessageId) return
    const nextContent = editingMessageContent
    setMessages((prev) =>
      prev.map((m) => (m.id === editingMessageId ? { ...m, content: nextContent, updatedAt: Date.now() } : m)),
    )
    await api.updateChatMessage(currentSessionId, editingMessageId, nextContent)
    await refreshSessions()
    setEditingMessageId(null)
    setEditingMessageContent('')
  }, [api, currentSessionId, editingMessageId, editingMessageContent, refreshSessions])

  const handleResend = useCallback(
    async (messageId: string) => {
      if (!api || !currentSessionId) return
      if (isLoadingRef.current) interrupt()

      const msgIndex = messages.findIndex((m) => m.id === messageId)
      if (msgIndex === -1) return

      let userIndex = msgIndex
      if (messages[msgIndex].role === 'assistant') {
        for (let i = msgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            userIndex = i
            break
          }
        }
      }

      const userMsg = messages[userIndex]
      if (!userMsg || userMsg.role !== 'user') return

      const aiService = getAIService()
      if (!aiService) {
        setError('AI 服务未初始化，请先配置 AI 设置')
        return
      }

      setContextMenu(null)
      setError(null)
      setIsLoading(true)
      isLoadingRef.current = true
      const abort = new AbortController()
      aiAbortRef.current = abort
      try {
        api.stopTtsAll()
      } catch (_) {
        /* ignore */
      }

      const truncated = messages.slice(0, userIndex + 1)
      setMessages(truncated)
      await api.setChatMessages(currentSessionId, truncated)

      try {
        let chatHistory: ChatMessage[] = truncated.map((m) => {
          if (m.role !== 'user') return { role: 'assistant', content: m.content }

          if (m.image && canUseVision) {
            const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
            const text = m.content === '[图片]' ? '' : m.content
            if (text.trim().length > 0) parts.push({ type: 'text', text })
            parts.push({ type: 'image_url', image_url: { url: m.image } })
            return { role: 'user', content: parts }
          }

          const plain = m.content.trim().length > 0 ? m.content : '[图片]'
          return { role: 'user', content: plain }
        })

        let systemAddon = ''
        try {
          const memEnabled = settings?.memory?.enabled ?? true
          if (!memEnabled) throw new Error('memory disabled')
          const queryText = userMsg.content.trim()
          if (queryText.length > 0) {
            const personaId = getActivePersonaId()
            const res = await api.retrieveMemory({
              personaId,
              query: queryText,
              limit: 12,
              maxChars: 3200,
              includeShared: settings?.memory?.includeSharedOnRetrieve ?? true,
            })
            systemAddon = res.addon?.trim() ?? ''
          }
        } catch (_) {
          systemAddon = ''
        }

        {
          const trimmed = trimChatHistoryToMaxContext(chatHistory, systemAddon)
          chatHistory = trimmed.history
          if (trimmed.trimmedCount > 0) {
            setError(
              `提示：对话上下文过长，已自动截断为最近 ${chatHistory.length} 条消息（本地仍保存全部）。可右键“一键总结”或清空对话。`,
            )
          }
        }

        const enableChatStreaming = settings?.ai?.enableChatStreaming ?? false
        const ttsSegmented = (settings?.tts?.enabled ?? false) && (settings?.tts?.segmented ?? false)

        if (ttsSegmented) {
          const utteranceId = newMessageId()
          const createdAt = Date.now()
          const assistantMessage: ChatMessageRecord = { id: utteranceId, role: 'assistant', content: '', createdAt }
          ttsUtteranceMetaRef.current[utteranceId] = {
            sessionId: currentSessionId,
            assistantMessageId: utteranceId,
            createdAt,
            displayedSegments: 0,
            accumulated: '',
          }

          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)

          api.enqueueTtsUtterance({ utteranceId, mode: 'replace', segments: [] })

          try {
            if (enableChatStreaming) {
              const segmenter = createStreamingSentenceSegmenter()
              let sentSegments = 0

              const response = await aiService.chatStream(chatHistory, {
                signal: abort.signal,
                systemAddon,
                onDelta: (delta) => {
                  const segs = segmenter.push(delta)
                  if (!segs.length) return
                  sentSegments += segs.length
                  api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: segs })
                },
              })

              if (response.error) {
                if (response.error === ABORTED_ERROR) {
                  api.finalizeTtsUtterance(utteranceId)
                  return
                }
                const errUi = formatAiErrorForUser(response.error)
                setError(errUi.message)
                if (errUi.shouldAlert) window.alert(errUi.message)
                const nextContent = `[错误] ${response.error}`
                setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
                await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
                api.finalizeTtsUtterance(utteranceId)
                return
              }

              if (ttsUtteranceMetaRef.current[utteranceId]) {
                ttsUtteranceMetaRef.current[utteranceId].fallbackContent = response.content
              }

              const tail = segmenter.flush()
              if (tail.length) {
                sentSegments += tail.length
                api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: tail })
              }

              if (sentSegments === 0 && response.content) {
                const segs = splitTextIntoSegments(response.content)
                if (segs.length) {
                  sentSegments += segs.length
                  api.enqueueTtsUtterance({ utteranceId, mode: 'append', segments: segs })
                }
              }

              api.finalizeTtsUtterance(utteranceId)
              if (response.expression) api.triggerExpression(response.expression)
              if (response.motion) api.triggerMotion(response.motion, 0)
              return
            }

            const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
            if (response.error) {
              if (response.error === ABORTED_ERROR) {
                api.finalizeTtsUtterance(utteranceId)
                return
              }
              const errUi = formatAiErrorForUser(response.error)
              setError(errUi.message)
              if (errUi.shouldAlert) window.alert(errUi.message)
              const nextContent = `[错误] ${response.error}`
              setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
              await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
              api.finalizeTtsUtterance(utteranceId)
              return
            }

            if (ttsUtteranceMetaRef.current[utteranceId]) {
              ttsUtteranceMetaRef.current[utteranceId].fallbackContent = response.content
            }

            const segs = splitTextIntoSegments(response.content)
            api.enqueueTtsUtterance({
              utteranceId,
              mode: 'append',
              segments: segs.length ? segs : [response.content],
            })
            api.finalizeTtsUtterance(utteranceId)

            if (response.expression) api.triggerExpression(response.expression)
            if (response.motion) api.triggerMotion(response.motion, 0)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg)
            const nextContent = `[错误] ${msg}`
            setMessages((prev) => prev.map((m) => (m.id === utteranceId ? { ...m, content: nextContent } : m)))
            await api.updateChatMessage(currentSessionId, utteranceId, nextContent).catch(() => undefined)
            api.finalizeTtsUtterance(utteranceId)
          }

          return
        }

        if (enableChatStreaming) {
          const assistantId = newMessageId()
          let created = false
          const createdAt = Date.now()
          let acc = ''
          let pending = ''
          let raf = 0

          const ensureMessageCreated = () => {
            if (created) return
            created = true
            const assistantMessage: ChatMessageRecord = {
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt,
            }
            setMessages((prev) => [...prev, assistantMessage])
            api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
          }

          const flush = () => {
            if (!pending) return
            acc += pending
            pending = ''
            if (!created) ensureMessageCreated()
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)))
          }

          const scheduleFlush = () => {
            if (raf) return
            raf = window.requestAnimationFrame(() => {
              raf = 0
              flush()
            })
          }

          const response = await aiService.chatStream(chatHistory, {
            signal: abort.signal,
            systemAddon,
            onDelta: (delta) => {
              pending += delta
              scheduleFlush()
            },
          })

          if (raf) {
            window.cancelAnimationFrame(raf)
            raf = 0
          }
          flush()

          if (response.error) {
            if (response.error === ABORTED_ERROR) {
              return
            }
            const errUi = formatAiErrorForUser(response.error)
            setError(errUi.message)
            if (errUi.shouldAlert) window.alert(errUi.message)
            const nextContent = `[错误] ${response.error}`
            if (created) {
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: nextContent } : m)))
              await api.updateChatMessage(currentSessionId, assistantId, nextContent).catch(() => undefined)
            } else {
              const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: nextContent, createdAt }
              setMessages((prev) => [...prev, msg])
              await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
            }
            return
          }

          if (created) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: response.content } : m)))
            await api.updateChatMessage(currentSessionId, assistantId, response.content).catch(() => undefined)
          } else {
            const msg: ChatMessageRecord = { id: assistantId, role: 'assistant', content: response.content, createdAt }
            setMessages((prev) => [...prev, msg])
            await api.addChatMessage(currentSessionId, msg).catch(() => undefined)
          }

          if (response.expression) api.triggerExpression(response.expression)
          if (response.motion) api.triggerMotion(response.motion, 0)
          if (response.content) api.sendBubbleMessage(response.content)
          void runAutoExtractIfNeeded(currentSessionId)
          return
        }

        const response = await aiService.chat(chatHistory, { signal: abort.signal, systemAddon })
        if (response.error) {
          if (response.error === ABORTED_ERROR) return
          const errUi = formatAiErrorForUser(response.error)
          setError(errUi.message)
          if (errUi.shouldAlert) window.alert(errUi.message)
          const assistantMessage: ChatMessageRecord = {
            id: newMessageId(),
            role: 'assistant',
            content: `[错误] ${response.error}`,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMessage])
          await api.addChatMessage(currentSessionId, assistantMessage)
          return
        }

        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: response.content,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage)

        if (response.expression) api.triggerExpression(response.expression)
        if (response.motion) api.triggerMotion(response.motion, 0)
        if (response.content) api.sendBubbleMessage(response.content)
        void runAutoExtractIfNeeded(currentSessionId)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        const assistantMessage: ChatMessageRecord = {
          id: newMessageId(),
          role: 'assistant',
          content: `[错误] ${errorMessage}`,
          createdAt: Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])
        await api.addChatMessage(currentSessionId, assistantMessage).catch(() => undefined)
      } finally {
        if (aiAbortRef.current === abort) aiAbortRef.current = null
        isLoadingRef.current = false
        setIsLoading(false)
        refreshSessions().catch(() => undefined)
      }
    },
    [
      api,
      canUseVision,
      currentSessionId,
      getActivePersonaId,
      interrupt,
      messages,
      newMessageId,
      refreshSessions,
      settings?.ai?.enableChatStreaming,
      settings?.memory?.enabled,
      settings?.memory?.includeSharedOnRetrieve,
      settings?.tts?.enabled,
      settings?.tts?.segmented,
      runAutoExtractIfNeeded,
      trimChatHistoryToMaxContext,
      formatAiErrorForUser,
    ],
  )

  const chatStyle = useMemo(() => {
    const ui = settings?.chatUi
    const bgImage = ui?.backgroundImage?.trim() ?? ''
    const imgOpacity = Math.max(0, Math.min(1, ui?.backgroundImageOpacity ?? 0.6))
    const overlay = bgImage ? 1 - imgOpacity : 0

    return {
      ['--ndp-chat-bg' as unknown as string]: ui?.background ?? 'rgba(20, 20, 24, 0.45)',
      ['--ndp-user-bubble-bg' as unknown as string]: ui?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)',
      ['--ndp-assistant-bubble-bg' as unknown as string]: ui?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)',
      ['--ndp-bubble-radius' as unknown as string]: `${ui?.bubbleRadius ?? 14}px`,
      backgroundImage: bgImage
        ? `linear-gradient(rgba(0,0,0,${overlay}), rgba(0,0,0,${overlay})), url(${bgImage})`
        : undefined,
      backgroundSize: bgImage ? 'cover' : undefined,
      backgroundPosition: bgImage ? 'center' : undefined,
      backgroundRepeat: bgImage ? 'no-repeat' : undefined,
    } as CSSProperties
  }, [settings?.chatUi])

  return (
    <div
      className="ndp-chat-root"
      style={chatStyle}
      onContextMenu={handleChatRootContextMenu}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.ndp-session-list')) return
        if ((e.target as HTMLElement).closest('.ndp-context-menu')) return
        closeOverlays()
      }}
    >
      <header className="ndp-chat-header">
        <button className="ndp-session-name" onClick={() => setShowSessionList((v) => !v)} title="对话管理">
          对话管理：{currentSession?.name ?? '新对话'}
          <span className={`ndp-session-arrow ${showSessionList ? 'open' : ''}`}>▾</span>
        </button>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={clearMessages} title="清空对话">
            清空
          </button>
          <button className="ndp-btn" onClick={() => api?.openSettings()}>
            设置
          </button>
          <button className="ndp-btn" onClick={() => api?.openMemory()}>
            记忆
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      <div className="ndp-chat-membar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ndp-chat-membar-left">
          <label className="ndp-chat-mem-toggle" title="采集：写入原文到长期记忆">
            <input type="checkbox" checked={captureEnabled} onChange={(e) => void toggleCaptureEnabled(e.target.checked)} />
            采集
          </label>
          <label className="ndp-chat-mem-toggle" title="召回：检索注入到对话上下文">
            <input type="checkbox" checked={retrieveEnabled} onChange={(e) => void toggleRetrieveEnabled(e.target.checked)} />
            召回
          </label>
          <label className="ndp-chat-mem-toggle" title="自动提炼：对话达到阈值后自动写入长期记忆">
            <input
              type="checkbox"
              checked={autoExtractEnabled}
              onChange={(e) => void toggleAutoExtractEnabled(e.target.checked)}
              disabled={!memEnabled}
            />
            自动提炼
          </label>
          <label className="ndp-chat-mem-toggle" title="工具：把“想做事”的话交给规划器生成任务（可在桌宠任务面板查看进度）">
            <input
              type="checkbox"
              checked={plannerEnabled}
              onChange={(e) => void toggleTaskPlannerEnabled(e.target.checked)}
            />
            工具
          </label>
          <select
            className="ndp-select ndp-chat-mem-select"
            value={plannerMode}
            onChange={(e) => void setTaskPlannerMode(e.target.value as 'auto' | 'always')}
            disabled={!plannerEnabled}
            title="auto=仅在像“想做事”的话时触发；always=每条消息都先过规划器"
          >
            <option value="auto">auto</option>
            <option value="always">always</option>
          </select>
        </div>
        <div className="ndp-chat-membar-right">
          <span title="有效消息=合并连续助手消息后的条数">有效 {effectiveCountUi}</span>
          <span>游标 {cursorUi}</span>
          <span title={`阈值=${everyUi}`}>还差 {memEnabled && autoExtractEnabled ? remainingUi : '-'}</span>
          <span>上次 {lastRunAtUi > 0 ? new Date(lastRunAtUi).toLocaleString() : '-'}</span>
          <span>写入 {lastWriteCountUi}</span>
          <span title={retrieveUi.title}>召回 {retrieveUi.text}</span>
          {lastErrorUi ? (
            <span className="ndp-chat-membar-error" title={lastErrorUi}>
              失败 {lastErrorPreviewUi}
            </span>
          ) : null}
        </div>
      </div>

      {showSessionList && (
        <div className="ndp-session-list" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ndp-session-list-header">
            <div className="ndp-session-current">{currentSession?.name ?? '对话'}</div>
            <button className="ndp-btn" onClick={handleNewSession}>
              新对话
            </button>
          </div>
          <div className="ndp-session-list-items">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`ndp-session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => handleSwitchSession(s.id)}
              >
                <div className="ndp-session-info">
                  {editingSessionId === s.id ? (
                    <input
                      className="ndp-session-rename-input"
                      value={editingSessionName}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingSessionName(e.target.value)}
                      onBlur={() => handleRenameSession(s.id, editingSessionName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSession(s.id, editingSessionName)
                        if (e.key === 'Escape') {
                          setEditingSessionId(null)
                          setEditingSessionName('')
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="ndp-session-item-name">{s.name}</span>
                      <span className="ndp-session-item-count">{s.messageCount} 条</span>
                    </>
                  )}
                </div>
                <div
                  className="ndp-session-actions"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="ndp-session-action"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingSessionId(s.id)
                      setEditingSessionName(s.name)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="ndp-session-action delete"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="ndp-chat-messages">
        {messages.length === 0 ? (
          <div className="ndp-chat-empty">
            <div className="ndp-muted">还没有消息</div>
            <div className="ndp-muted ndp-chat-hint">
              {settings?.ai?.apiKey ? (
                <>模型: {settings.ai.model}</>
              ) : (
                <>请先在设置中配置 API Key</>
              )}
            </div>
          </div>
        ) : null}
        {messages.map((m) => {
          const profile = settings?.chatProfile
          const isUser = m.role === 'user'
          const avatar = isUser ? profile?.userAvatar : profile?.assistantAvatar

          return (
            <div
              key={m.id}
              className={`ndp-msg-row ${isUser ? 'ndp-msg-row-user' : 'ndp-msg-row-pet'}`}
              onContextMenu={(e) => handleMessageContextMenu(e, m.id)}
              title={new Date(m.createdAt).toLocaleString()}
            >
              {!isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('assistant')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="assistant" /> : <span>宠</span>}
                </div>
              ) : null}

              <div className={`ndp-msg ndp-msg-${isUser ? 'user' : 'pet'}`}>
                {editingMessageId === m.id ? (
                  <div className="ndp-msg-edit">
                    <textarea
                      ref={editingTextareaRef}
                      className="ndp-inline-textarea"
                      value={editingMessageContent}
                      rows={1}
                      onChange={(e) => setEditingMessageContent(e.target.value)}
                      onInput={(e) => {
                        const el = e.currentTarget
                        el.style.height = '0px'
                        el.style.height = `${el.scrollHeight}px`
                      }}
                    />
                    <div className="ndp-msg-edit-actions">
                      <button className="ndp-btn" onClick={handleSaveEdit}>
                        保存
                      </button>
                      <button className="ndp-btn" onClick={handleCancelEdit}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ndp-msg-content">
                    {m.content}
                    {m.image ? (
                      <img
                        className="ndp-msg-image"
                        src={m.image}
                        alt="attachment"
                        onClick={() => window.open(m.image, '_blank')}
                      />
                    ) : null}
                  </div>
                )}
              </div>

              {isUser ? (
                <div className="ndp-avatar ndp-avatar-clickable" onClick={() => pickAvatar('user')} title="点击更换头像">
                  {avatar ? <img src={avatar} alt="user" /> : <span>我</span>}
                </div>
              ) : null}
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </main>

      {error && (
        <div className="ndp-chat-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <footer className="ndp-chat-input">
        {pendingImage ? (
          <div className="ndp-input-preview" onMouseDown={(e) => e.stopPropagation()}>
            <img src={pendingImage} alt="preview" />
            <button className="ndp-preview-remove" onClick={() => setPendingImage(null)} title="移除图片">
              ×
            </button>
          </div>
        ) : null}
        <div className="ndp-chat-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const items = e.clipboardData?.items
              if (!items) return
              for (const item of items) {
                if (item.type.startsWith('image/')) {
                  if (!canUseVision) {
                    e.preventDefault()
                    setError('请先在设置中开启识图能力')
                    break
                  }
                  e.preventDefault()
                  const file = item.getAsFile()
                  if (file) readChatImageFile(file)
                  break
                }
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              const file = e.dataTransfer?.files?.[0]
              if (!file) return
              if (file.type.startsWith('image/') && !canUseVision) {
                setError('请先在设置中开启识图能力')
                return
              }
              readChatImageFile(file)
            }}
            onDragOver={(e) => e.preventDefault()}
            placeholder="输入一句话..."
          />
          <button
            className="ndp-btn"
            onClick={() => imageInputRef.current?.click()}
            disabled={!canUseVision}
            title={canUseVision ? '选择图片' : '请先在设置中开启识图能力'}
          >
            图片
          </button>
          <button className="ndp-btn" onClick={() => send()} disabled={!input.trim() && !pendingImage && !isLoading}>
            {isLoading ? (!input.trim() && !pendingImage ? '打断' : '打断并发送') : '发送'}
          </button>
        </div>
      </footer>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          readChatImageFile(file)
          e.currentTarget.value = ''
        }}
      />

      <input
        ref={userAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ userAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />
      <input
        ref={assistantAvatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file || !api) return
          readAvatarFile(file, (dataUrl) => api.setChatProfile({ assistantAvatar: dataUrl }))
          e.currentTarget.value = ''
        }}
      />

      {sessionContextMenu ? (
        <div className="ndp-context-menu" style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}>
          <button onClick={() => void runQuickExtract()}>一键总结（写入长期记忆）</button>
        </div>
      ) : null}

      {contextMenu ? (
        <div className="ndp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => handleResend(contextMenu.messageId)}>🔄 重新生成</button>
          <button onClick={() => handleStartEdit(contextMenu.messageId)}>✏️ 编辑</button>
          <button className="delete" onClick={() => handleDeleteMessage(contextMenu.messageId)}>
            🗑️ 删除
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SettingsWindow(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const [activeTab, setActiveTab] = useState<
    'live2d' | 'bubble' | 'taskPanel' | 'ai' | 'persona' | 'chat' | 'tts' | 'asr'
  >('live2d')
  const [availableModels, setAvailableModels] = useState<Live2DModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(true)
  const lastModelScanAtRef = useRef(0)

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dModelId = settings?.live2dModelId ?? 'haru'
  const aiSettings = settings?.ai
  const bubbleSettings = settings?.bubble
  const chatUi = settings?.chatUi
  const ttsSettings = settings?.tts
  const asrSettings = settings?.asr

  const refreshModels = useCallback(
    async (opts?: { force?: boolean }) => {
      const now = Date.now()
      if (!opts?.force && now - lastModelScanAtRef.current < 800) return
      lastModelScanAtRef.current = now

      setIsLoadingModels(true)
      try {
        const models = await scanAvailableModels()
        setAvailableModels(models)
      } catch (err) {
        console.error('[Settings] Failed to scan models:', err)
        // Fallback to cached models
        setAvailableModels(getAvailableModels())
      } finally {
        setIsLoadingModels(false)
      }
    },
    [setAvailableModels, setIsLoadingModels],
  )

  // Scan models on mount
  useEffect(() => {
    void refreshModels({ force: true })
  }, [refreshModels])
  const [selectedModelInfo, setSelectedModelInfo] = useState<Live2DModelInfo | null>(null)

  // Load model metadata when model changes or models are loaded
  useEffect(() => {
    const model = availableModels.find((m) => m.id === live2dModelId)
    if (!model) {
      setSelectedModelInfo(null)
      return
    }

    // Start with basic info
    setSelectedModelInfo(model)

    // Then load full metadata
    parseModelMetadata(model.modelFile).then((metadata) => {
      setSelectedModelInfo({
        ...model,
        ...metadata,
      })
    })
  }, [live2dModelId, availableModels])

  return (
    <div className="ndp-settings-root">
      {/* Header */}
      <header className="ndp-settings-header">
        <div className="ndp-settings-title">
          <span className="ndp-settings-icon">⚙️</span>
          <span>设置</span>
        </div>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={() => api?.openMemory()}>
            记忆控制台
          </button>
          <button className="ndp-btn ndp-btn-close" onClick={() => api?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="ndp-settings-tabs">
        <button
          className={`ndp-tab-btn ${activeTab === 'live2d' ? 'active' : ''}`}
          onClick={() => setActiveTab('live2d')}
        >
          Live2D 模型
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'bubble' ? 'active' : ''}`}
          onClick={() => setActiveTab('bubble')}
        >
          气泡设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'taskPanel' ? 'active' : ''}`}
          onClick={() => setActiveTab('taskPanel')}
        >
          任务面板
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI 设置
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'persona' ? 'active' : ''}`}
          onClick={() => setActiveTab('persona')}
        >
          角色/记忆
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          聊天界面
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveTab('tts')}
        >
          TTS
        </button>
        <button
          className={`ndp-tab-btn ${activeTab === 'asr' ? 'active' : ''}`}
          onClick={() => setActiveTab('asr')}
        >
          语音识别
        </button>
      </div>

      {/* Content */}
      <main className="ndp-settings-content">
        {activeTab === 'live2d' && (
          <Live2DSettingsTab
            api={api}
            petScale={petScale}
            petOpacity={petOpacity}
            live2dModelId={live2dModelId}
            availableModels={availableModels}
            selectedModelInfo={selectedModelInfo}
            isLoadingModels={isLoadingModels}
            refreshModels={refreshModels}
          />
        )}
        {activeTab === 'bubble' && <BubbleSettingsTab api={api} bubbleSettings={bubbleSettings} />}
        {activeTab === 'taskPanel' && <TaskPanelSettingsTab api={api} taskPanelSettings={settings?.taskPanel} />}
        {activeTab === 'ai' && <AISettingsTab api={api} aiSettings={aiSettings} />}
        {activeTab === 'persona' && <PersonaSettingsTab api={api} settings={settings} />}
        {activeTab === 'chat' && <ChatUiSettingsTab api={api} chatUi={chatUi} />}
        {activeTab === 'tts' && <TtsSettingsTab api={api} ttsSettings={ttsSettings} />}
        {activeTab === 'asr' && <AsrSettingsTab api={api} asrSettings={asrSettings} />}
      </main>

      {/* Footer */}
      <footer className="ndp-settings-footer">
        <button className="ndp-reset-btn" disabled>
          重置默认
        </button>
      </footer>
    </div>
  )
}

function PersonaSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const activePersonaId = settings?.activePersonaId ?? 'default'
  const memoryEnabled = settings?.memory?.enabled ?? true
  const includeSharedOnRetrieve = settings?.memory?.includeSharedOnRetrieve ?? true
  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const autoExtractEveryEffectiveMessages = settings?.memory?.autoExtractEveryEffectiveMessages ?? 20
  const autoExtractMaxEffectiveMessages = settings?.memory?.autoExtractMaxEffectiveMessages ?? 60
  const autoExtractCooldownMs = settings?.memory?.autoExtractCooldownMs ?? 120000
  const autoExtractUseCustomAi = settings?.memory?.autoExtractUseCustomAi ?? false
  const autoExtractAiBaseUrl = settings?.memory?.autoExtractAiBaseUrl ?? ''
  const autoExtractAiApiKey = settings?.memory?.autoExtractAiApiKey ?? ''
  const autoExtractAiModel = settings?.memory?.autoExtractAiModel ?? ''
  const autoExtractAiTemperature = settings?.memory?.autoExtractAiTemperature ?? 0.2
  const autoExtractAiMaxTokens = settings?.memory?.autoExtractAiMaxTokens ?? 1600

  const tagEnabled = settings?.memory?.tagEnabled ?? true
  const tagMaxExpand = settings?.memory?.tagMaxExpand ?? 6

  const vectorEnabled = settings?.memory?.vectorEnabled ?? false
  const vectorEmbeddingModel = settings?.memory?.vectorEmbeddingModel ?? 'text-embedding-3-small'
  const vectorMinScore = settings?.memory?.vectorMinScore ?? 0.35
  const vectorTopK = settings?.memory?.vectorTopK ?? 20
  const vectorScanLimit = settings?.memory?.vectorScanLimit ?? 2000
  const vectorUseCustomAi = settings?.memory?.vectorUseCustomAi ?? false
  const vectorAiBaseUrl = settings?.memory?.vectorAiBaseUrl ?? ''
  const vectorAiApiKey = settings?.memory?.vectorAiApiKey ?? ''

  const kgEnabled = settings?.memory?.kgEnabled ?? false
  const kgIncludeChatMessages = settings?.memory?.kgIncludeChatMessages ?? false
  const kgUseCustomAi = settings?.memory?.kgUseCustomAi ?? true
  const kgAiBaseUrl = settings?.memory?.kgAiBaseUrl ?? ''
  const kgAiApiKey = settings?.memory?.kgAiApiKey ?? ''
  const kgAiModel = settings?.memory?.kgAiModel ?? 'gpt-4o-mini'
  const kgAiTemperature = settings?.memory?.kgAiTemperature ?? 0.2
  const kgAiMaxTokens = settings?.memory?.kgAiMaxTokens ?? 1200

  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [memScope, setMemScope] = useState<'persona' | 'shared' | 'all'>('persona')
  const [memRole, setMemRole] = useState<'all' | 'user' | 'assistant' | 'note'>('all')
  const [memQuery, setMemQuery] = useState('')
  const [memItems, setMemItems] = useState<Array<{ rowid: number; createdAt: number; role: string | null; kind: string; scope: string; content: string }>>([])
  const [memTotal, setMemTotal] = useState(0)
  const [memOffset, setMemOffset] = useState(0)
  const [memNewText, setMemNewText] = useState('')
  const [memNewScope, setMemNewScope] = useState<'persona' | 'shared'>('persona')
  const saveTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (!api) return
    const list = await api.listPersonas()
    setPersonas(list)
  }, [api])

  const refreshMemoryList = useCallback(async () => {
    if (!api) return
    const res = await api.listMemory({
      personaId: activePersonaId,
      scope: memScope,
      role: memRole,
      query: memQuery.trim() || undefined,
      limit: 50,
      offset: memOffset,
    })
    setMemTotal(res.total)
    setMemItems(res.items)
  }, [api, activePersonaId, memScope, memRole, memQuery, memOffset])

  useEffect(() => {
    if (!api) return
    void refresh().catch((err) => console.error('[Persona] listPersonas failed:', err))
  }, [api, refresh])

  useEffect(() => {
    void (async () => {
      if (!api) return
      const p = await api.getPersona(activePersonaId)
      setCurrentPersona(p)
      setDraftName(p?.name ?? '')
      setDraftPrompt(p?.prompt ?? '')
      setMemScope('persona')
      setMemRole('all')
      setMemQuery('')
      setMemOffset(0)
    })().catch((err) => console.error('[Persona] getPersona failed:', err))
  }, [api, activePersonaId])

  useEffect(() => {
    if (!api) return
    void refreshMemoryList().catch((err) => console.error('[Memory] list failed:', err))
  }, [api, refreshMemoryList])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [])

  const scheduleSavePrompt = useCallback(
    (personaId: string, prompt: string) => {
      if (!api) return
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        void api
          .updatePersona(personaId, { prompt })
          .then((p) => setCurrentPersona(p))
          .catch((err) => console.error('[Persona] updatePersona failed:', err))
      }, 450)
    },
    [api],
  )

  const scheduleSavePersonaFlags = useCallback(
    (personaId: string, patch: { captureEnabled?: boolean; captureUser?: boolean; captureAssistant?: boolean; retrieveEnabled?: boolean }) => {
      if (!api) return
      void api
        .updatePersona(personaId, patch)
        .then((p) => setCurrentPersona(p))
        .catch((err) => console.error('[Persona] updatePersona flags failed:', err))
    },
    [api],
  )

  const onChangePersona = useCallback(
    async (personaId: string) => {
      if (!api) return
      await api.setActivePersonaId(personaId)
    },
    [api],
  )

  const onToggleGlobalMemory = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ enabled })
    },
    [api],
  )

  const onToggleIncludeShared = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ includeSharedOnRetrieve: enabled })
    },
    [api],
  )

  const onSetAutoExtractSettings = useCallback(
    async (patch: Partial<AppSettings['memory']>) => {
      if (!api) return
      await api.setMemorySettings(patch)
    },
    [api],
  )

  const onCreatePersona = useCallback(async () => {
    if (!api) return
    const created = await api.createPersona('新角色')
    await refresh()
    await api.setActivePersonaId(created.id)
  }, [api, refresh])

  const onRenamePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    const nextName = draftName.trim()
    if (!nextName) return
    await api.updatePersona(currentPersona.id, { name: nextName })
    await refresh()
  }, [api, currentPersona, draftName, refresh])

  const onDeletePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    if (currentPersona.id === 'default') return
    const ok = window.confirm(`确定删除角色「${currentPersona.name}」？\n该操作会删除人设配置；聊天会话仍会保留在本地。`)
    if (!ok) return
    await api.deletePersona(currentPersona.id)
    await refresh()
    await api.setActivePersonaId('default')
  }, [api, currentPersona, refresh])

  const onAddManualMemory = useCallback(async () => {
    if (!api) return
    const content = memNewText.trim()
    if (!content) return
    await api.upsertManualMemory({ personaId: activePersonaId, scope: memNewScope, content })
    setMemNewText('')
    setMemOffset(0)
    await refreshMemoryList()
  }, [api, activePersonaId, memNewScope, memNewText, refreshMemoryList])

  const onDeleteMemory = useCallback(
    async (rowid: number) => {
      if (!api) return
      const ok = window.confirm('确定删除这条记忆？')
      if (!ok) return
      await api.deleteMemory({ rowid })
      await refreshMemoryList()
    },
    [api, refreshMemoryList],
  )

  if (!api) {
    return (
      <div className="ndp-settings-section">
        <h3>角色</h3>
        <p className="ndp-setting-hint">API 未就绪，请稍后再试。</p>
      </div>
    )
  }

  return (
    <div className="ndp-settings-section">
      <h3>角色</h3>

      <div className="ndp-setting-item">
        <label>当前角色</label>
        <div className="ndp-row">
          <select className="ndp-select" value={activePersonaId} onChange={(e) => void onChangePersona(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="ndp-btn" onClick={() => void onCreatePersona()}>
            新建
          </button>
          <button className="ndp-btn" disabled={!currentPersona || currentPersona.id === 'default'} onClick={() => void onDeletePersona()}>
            删除
          </button>
        </div>
        <p className="ndp-setting-hint">每个角色的长期记忆与会话列表隔离；公共事实层后续再加。</p>
      </div>

      <div className="ndp-setting-item">
        <label>角色名称</label>
        <div className="ndp-row">
          <input className="ndp-input" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          <button className="ndp-btn" disabled={!currentPersona} onClick={() => void onRenamePersona()}>
            保存
          </button>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>人设补充提示词</label>
        <textarea
          className="ndp-textarea"
          rows={10}
          value={draftPrompt}
          placeholder="写下这个角色的口癖、价值观、禁忌、关系设定等（会追加到全局 systemPrompt 后）"
          onChange={(e) => {
            const next = e.target.value
            setDraftPrompt(next)
            if (currentPersona) scheduleSavePrompt(currentPersona.id, next)
          }}
        />
        <p className="ndp-setting-hint">建议只写“稳定约束”。对话原文会自动写入长期记忆库用于召回。</p>
      </div>

      <h3>记忆开关</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={memoryEnabled} onChange={(e) => void onToggleGlobalMemory(e.target.checked)} />
          <span>启用长期记忆（全局）</span>
        </label>
        <p className="ndp-setting-hint">关闭后不会再记录新内容，也不会将记忆注入到提示词。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={includeSharedOnRetrieve}
            onChange={(e) => void onToggleIncludeShared(e.target.checked)}
          />
          <span>检索时包含共享记忆（默认）</span>
        </label>
      </div>

      <h3>召回增强（M5）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={tagEnabled}
            onChange={(e) => void onSetAutoExtractSettings({ tagEnabled: e.target.checked })}
          />
          <span>启用 Tag 网络（模糊问法扩展，本地低延迟）</span>
        </label>
        <p className="ndp-setting-hint">把重点词拆成轻量 Tag，用于模糊问法的扩展与召回。</p>
      </div>

      <div className="ndp-setting-item">
        <label>Tag 扩展数（0=不扩展）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={40}
          value={tagMaxExpand}
          onChange={(e) => void onSetAutoExtractSettings({ tagMaxExpand: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={vectorEnabled}
            onChange={(e) => void onSetAutoExtractSettings({ vectorEnabled: e.target.checked })}
          />
          <span>启用向量召回（更强，需 embeddings API）</span>
        </label>
        <p className="ndp-setting-hint">启用后会在后台逐步补齐你的记忆嵌入，不会阻塞聊天。</p>
      </div>

      <div className="ndp-setting-item">
        <label>embeddings 模型</label>
        <input
          className="ndp-input"
          value={vectorEmbeddingModel}
          placeholder="例如：text-embedding-3-small"
          onChange={(e) => void onSetAutoExtractSettings({ vectorEmbeddingModel: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量最低相似度（0~1）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={vectorMinScore}
          onChange={(e) => void onSetAutoExtractSettings({ vectorMinScore: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量 TopK</label>
        <input
          className="ndp-input"
          type="number"
          min={1}
          max={100}
          value={vectorTopK}
          onChange={(e) => void onSetAutoExtractSettings({ vectorTopK: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量扫描上限（降低延迟）</label>
        <input
          className="ndp-input"
          type="number"
          min={200}
          max={200000}
          value={vectorScanLimit}
          onChange={(e) => void onSetAutoExtractSettings({ vectorScanLimit: Number(e.target.value) })}
        />
        <p className="ndp-setting-hint">数值越大→召回上限更高，但也会更慢。建议先从 2000 开始。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={vectorUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ vectorUseCustomAi: e.target.checked })}
          />
          <span>向量使用单独 API Key/BaseUrl</span>
        </label>
        {!vectorUseCustomAi ? (
          <p className="ndp-setting-hint">当前将使用聊天的 API Key/BaseUrl。</p>
        ) : null}
      </div>

      {vectorUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>embeddings BaseUrl</label>
            <input
              className="ndp-input"
              value={vectorAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>embeddings API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={vectorAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiApiKey: e.target.value })}
            />
          </div>
        </>
      ) : null}

      <h3>图谱层（M6，可选）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={kgEnabled} onChange={(e) => void onSetAutoExtractSettings({ kgEnabled: e.target.checked })} />
          <span>启用 KG（实体/关系）召回</span>
        </label>
        <p className="ndp-setting-hint">开启后会在后台用 LLM 抽取实体/关系，并在召回时用“图谱证据”补命中（仍以低延迟为优先）。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgIncludeChatMessages}
            onChange={(e) => void onSetAutoExtractSettings({ kgIncludeChatMessages: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>抽取 chat_message（更全但更噪）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ kgUseCustomAi: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>KG 抽取使用单独 API</span>
        </label>
      </div>

      {kgEnabled && kgUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>KG BaseUrl</label>
            <input
              className="ndp-input"
              value={kgAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={kgAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ kgAiApiKey: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG 模型</label>
            <input
              className="ndp-input"
              value={kgAiModel}
              placeholder="例如：gpt-4o-mini"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={kgAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiTemperature: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG MaxTokens</label>
            <input
              className="ndp-input"
              type="number"
              min={200}
              max={8000}
              value={kgAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </>
      ) : null}

      <h3>自动提炼</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractEnabled}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractEnabled: e.target.checked })}
          />
          <span>对话超过阈值自动提炼（写入长期记忆）</span>
        </label>
        <p className="ndp-setting-hint">
          计数采用“有效消息”：会把连续的助手分句（例如 TTS 分句产生的多条助手消息）合并为 1 条来计算，避免过于频繁提炼。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>每新增多少条有效消息触发一次</label>
        <input
          className="ndp-input"
          type="number"
          min={2}
          max={2000}
          value={autoExtractEveryEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractEveryEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>提炼窗口：最多取最近多少条有效消息</label>
        <input
          className="ndp-input"
          type="number"
          min={10}
          max={2000}
          value={autoExtractMaxEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractMaxEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>自动提炼最小间隔（秒）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={3600}
          value={Math.round(autoExtractCooldownMs / 1000)}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractCooldownMs: Number(e.target.value) * 1000 })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractUseCustomAi: e.target.checked })}
          />
          <span>自动提炼使用单独的 LLM 配置（不影响聊天主模型）</span>
        </label>
      </div>

      {autoExtractUseCustomAi && (
        <div className="ndp-setting-item">
          <label>自动提炼 LLM 配置</label>
          <div className="ndp-setting-hint">留空表示继承聊天主模型对应字段。</div>
          <div className="ndp-setting-item">
            <label>Base URL</label>
            <input
              className="ndp-input"
              placeholder="例如：https://api.openai.com/v1"
              value={autoExtractAiBaseUrl}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiBaseUrl: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>API Key</label>
            <input
              className="ndp-input"
              type="password"
              placeholder="留空则继承聊天主模型"
              value={autoExtractAiApiKey}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiApiKey: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Model</label>
            <input
              className="ndp-input"
              placeholder="例如：gpt-4o-mini"
              value={autoExtractAiModel}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiModel: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={autoExtractAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiTemperature: Number(e.target.value) })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Max Tokens</label>
            <input
              className="ndp-input"
              type="number"
              min={128}
              max={64000}
              step={128}
              value={autoExtractAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

      <div className="ndp-setting-item">
        <label>当前角色：写入 / 召回</label>
        <div className="ndp-setting-item">
          <label className="ndp-checkbox-label">
            <input
              type="checkbox"
              checked={currentPersona?.captureEnabled ?? true}
              onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureEnabled: e.target.checked })}
            />
            <span>允许写入该角色的长期记忆</span>
          </label>
        </div>
        <div className="ndp-setting-item">
          <label className="ndp-checkbox-label">
            <input
              type="checkbox"
              checked={currentPersona?.captureUser ?? true}
              onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureUser: e.target.checked })}
            />
            <span>记录用户消息</span>
          </label>
        </div>
        <div className="ndp-setting-item">
          <label className="ndp-checkbox-label">
            <input
              type="checkbox"
              checked={currentPersona?.captureAssistant ?? true}
              onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureAssistant: e.target.checked })}
            />
            <span>记录 AI 消息</span>
          </label>
        </div>
        <div className="ndp-setting-item">
          <label className="ndp-checkbox-label">
            <input
              type="checkbox"
              checked={currentPersona?.retrieveEnabled ?? true}
              onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { retrieveEnabled: e.target.checked })}
            />
            <span>允许该角色参与召回注入</span>
          </label>
        </div>
      </div>

      <h3>记忆管理</h3>

      <div className="ndp-setting-item">
        <label>手动添加</label>
        <div className="ndp-row">
          <select className="ndp-select" value={memNewScope} onChange={(e) => setMemNewScope(e.target.value as 'persona' | 'shared')}>
            <option value="persona">当前角色</option>
            <option value="shared">共享</option>
          </select>
          <button className="ndp-btn" onClick={() => void onAddManualMemory()} disabled={!memNewText.trim()}>
            添加
          </button>
        </div>
        <textarea
          className="ndp-textarea ndp-textarea-compact"
          rows={3}
          value={memNewText}
          placeholder="写一条手动记忆（例如：长期设定、重要事实、约束）"
          onChange={(e) => setMemNewText(e.target.value)}
        />
      </div>

      <div className="ndp-setting-item">
        <label>筛选</label>
        <div className="ndp-row">
          <select
            className="ndp-select"
            value={memScope}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'persona' || v === 'shared' || v === 'all') setMemScope(v)
              setMemOffset(0)
            }}
          >
            <option value="persona">当前角色</option>
            <option value="shared">共享</option>
            <option value="all">当前角色 + 共享</option>
          </select>
          <select
            className="ndp-select"
            value={memRole}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'all' || v === 'user' || v === 'assistant' || v === 'note') setMemRole(v)
              setMemOffset(0)
            }}
          >
            <option value="all">全部</option>
            <option value="user">用户</option>
            <option value="assistant">AI</option>
            <option value="note">笔记</option>
          </select>
        </div>
        <div className="ndp-row" style={{ marginTop: 10 }}>
          <input className="ndp-input" value={memQuery} placeholder="关键词（LIKE）" onChange={(e) => setMemQuery(e.target.value)} />
          <button className="ndp-btn" onClick={() => { setMemOffset(0); void refreshMemoryList() }}>
            搜索
          </button>
        </div>
        <p className="ndp-setting-hint">共 {memTotal} 条</p>
      </div>

      <div className="ndp-setting-item">
        <label>列表</label>
        <div className="ndp-memory-list">
          {memItems.length === 0 && <div className="ndp-setting-hint">暂无记录</div>}
          {memItems.map((m) => (
            <div key={m.rowid} className="ndp-memory-item">
              <div className="ndp-memory-meta">
                <span>#{m.rowid}</span>
                <span>{new Date(m.createdAt).toLocaleString()}</span>
                <span>{m.scope}</span>
                <span>{m.role ?? 'note'}</span>
                <span>{m.kind}</span>
              </div>
              <div className="ndp-memory-content">{m.content}</div>
              <div className="ndp-memory-actions">
                <button className="ndp-btn" onClick={() => void onDeleteMemory(m.rowid)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="ndp-row" style={{ marginTop: 10 }}>
          <button className="ndp-btn" disabled={memOffset === 0} onClick={() => setMemOffset((o) => Math.max(0, o - 50))}>
            上一页
          </button>
          <button className="ndp-btn" disabled={memOffset + 50 >= memTotal} onClick={() => setMemOffset((o) => o + 50)}>
            下一页
          </button>
          <button className="ndp-btn" onClick={() => void refreshMemoryList()}>
            刷新
          </button>
        </div>
      </div>
    </div>
  )
}

// Live2D Settings Tab Component
function Live2DSettingsTab(props: {
  api: ReturnType<typeof getApi>
  petScale: number
  petOpacity: number
  live2dModelId: string
  availableModels: Live2DModelInfo[]
  selectedModelInfo: Live2DModelInfo | null
  isLoadingModels: boolean
  refreshModels: (opts?: { force?: boolean }) => Promise<void>
}) {
  const { api, petScale, petOpacity, live2dModelId, availableModels, selectedModelInfo, isLoadingModels, refreshModels } = props
  const triggerRefresh = useCallback(() => {
    void refreshModels()
  }, [refreshModels])

  return (
    <div className="ndp-settings-section">
      <h3>Live2D 模型设置</h3>

      {/* Model Selection */}
      <div className="ndp-setting-item">
        <label>选择模型</label>
        <select
          className="ndp-select"
          value={live2dModelId}
          onMouseDown={triggerRefresh}
          onFocus={triggerRefresh}
          onChange={(e) => {
            const selectedModel = availableModels.find((m) => m.id === e.target.value)
            if (selectedModel) {
              api?.setLive2dModel(selectedModel.id, selectedModel.modelFile)
            }
          }}
          disabled={isLoadingModels}
        >
          {isLoadingModels ? (
            <option value="">扫描模型中...</option>
          ) : availableModels.length === 0 ? (
            <option value="">未找到模型</option>
          ) : (
            availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))
          )}
        </select>
        <p className="ndp-setting-hint">
          {isLoadingModels ? '正在扫描 live2d 目录...' : `共 ${availableModels.length} 个模型可用`}
        </p>
      </div>

      {/* Model Info */}
      {selectedModelInfo && (
        <div className="ndp-model-info">
          <p className="ndp-model-path">
            路径: <code>{selectedModelInfo.modelFile}</code>
          </p>
          <div className="ndp-model-features">
            {selectedModelInfo.hasPhysics && <span className="ndp-feature-tag">物理</span>}
            {selectedModelInfo.hasPose && <span className="ndp-feature-tag">姿势</span>}
            {selectedModelInfo.expressions && selectedModelInfo.expressions.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.expressions.length} 表情</span>
            )}
            {selectedModelInfo.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
              <span className="ndp-feature-tag">{selectedModelInfo.motionGroups.length} 动作组</span>
            )}
          </div>
        </div>
      )}

      {/* Expression Test */}
      {selectedModelInfo?.expressions && selectedModelInfo.expressions.length > 0 && (
        <div className="ndp-setting-item">
          <label>表情测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.expressions.map((exp) => (
              <button
                key={exp.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerExpression(exp.name)}
              >
                {exp.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Motion Test */}
      {selectedModelInfo?.motionGroups && selectedModelInfo.motionGroups.length > 0 && (
        <div className="ndp-setting-item">
          <label>动作测试</label>
          <div className="ndp-test-buttons">
            {selectedModelInfo.motionGroups.map((group) => (
              <button
                key={group.name}
                className="ndp-test-btn"
                onClick={() => api?.triggerMotion(group.name, 0)}
              >
                {group.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ndp-setting-item">
        <label>模型大小</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="5"
            step="0.1"
            value={petScale}
            onChange={(e) => api?.setPetScale(parseFloat(e.target.value))}
          />
          <span>{petScale.toFixed(1)}x</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的显示大小（高分辨率模型可能需要更大的值）</p>
      </div>

      <div className="ndp-setting-item">
        <label>模型透明度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.3"
            max="1.0"
            step="0.1"
            value={petOpacity}
            onChange={(e) => api?.setPetOpacity(parseFloat(e.target.value))}
          />
          <span>{Math.round(petOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">调整 Live2D 模型的透明度</p>
      </div>
    </div>
  )
}

// Bubble Settings Tab Component
function BubbleSettingsTab(props: {
  api: ReturnType<typeof getApi>
  bubbleSettings: AppSettings['bubble'] | undefined
}) {
  const { api, bubbleSettings } = props
  const [phrasesText, setPhrasesText] = useState('')

  const style = bubbleSettings?.style ?? 'cute'
  const positionX = bubbleSettings?.positionX ?? 75
  const positionY = bubbleSettings?.positionY ?? 10
  const tailDirection = bubbleSettings?.tailDirection ?? 'down'
  const showOnClick = bubbleSettings?.showOnClick ?? true
  const showOnChat = bubbleSettings?.showOnChat ?? true
  const autoHideDelay = bubbleSettings?.autoHideDelay ?? 5000
  const clickPhrases = bubbleSettings?.clickPhrases ?? []
  const clickPhrasesText = clickPhrases.join('\n')

  // Sync phrases text with settings
  useEffect(() => {
    setPhrasesText(clickPhrasesText)
  }, [clickPhrasesText])

  const styleOptions: { value: BubbleStyle; label: string; desc: string }[] = [
    { value: 'cute', label: '可爱粉', desc: '粉色渐变，带爱心装饰' },
    { value: 'pixel', label: '像素风', desc: '复古像素游戏风格' },
    { value: 'minimal', label: '简约白', desc: '简洁现代风格' },
    { value: 'cloud', label: '云朵蓝', desc: '蓝色云朵造型' },
  ]

  const tailOptions: { value: TailDirection; label: string; icon: string }[] = [
    { value: 'up', label: '上', icon: '↑' },
    { value: 'down', label: '下', icon: '↓' },
    { value: 'left', label: '左', icon: '←' },
    { value: 'right', label: '右', icon: '→' },
  ]

  const handlePhrasesChange = (text: string) => {
    setPhrasesText(text)
  }

  const handlePhrasesSave = () => {
    const phrases = phrasesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    api?.setBubbleSettings({ clickPhrases: phrases })
  }

  return (
    <div className="ndp-settings-section">
      <h3>气泡样式</h3>

      {/* Style Selection */}
      <div className="ndp-setting-item">
        <label>气泡风格</label>
        <div className="ndp-style-grid">
          {styleOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-style-btn ${style === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ style: opt.value })}
            >
              <span className="ndp-style-label">{opt.label}</span>
              <span className="ndp-style-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Position X */}
      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionX}
            onChange={(e) => api?.setBubbleSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      {/* Position Y */}
      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={positionY}
            onChange={(e) => api?.setBubbleSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>

      {/* Tail Direction */}
      <div className="ndp-setting-item">
        <label>尾巴方向</label>
        <div className="ndp-tail-grid">
          {tailOptions.map((opt) => (
            <button
              key={opt.value}
              className={`ndp-tail-btn ${tailDirection === opt.value ? 'active' : ''}`}
              onClick={() => api?.setBubbleSettings({ tailDirection: opt.value })}
            >
              <span className="ndp-tail-icon">{opt.icon}</span>
              <span className="ndp-tail-label">{opt.label}</span>
            </button>
          ))}
        </div>
        <p className="ndp-setting-hint">气泡尾巴指向的方向</p>
      </div>

      <h3>显示设置</h3>

      {/* Show on Click */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnClick}
            onChange={(e) => api?.setBubbleSettings({ showOnClick: e.target.checked })}
          />
          <span>点击宠物时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">点击桌宠时随机显示可爱的台词</p>
      </div>

      {/* Show on Chat */}
      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={showOnChat}
            onChange={(e) => api?.setBubbleSettings({ showOnChat: e.target.checked })}
          />
          <span>AI 回复时显示气泡</span>
        </label>
        <p className="ndp-setting-hint">AI 回复消息时在桌宠旁边显示气泡</p>
      </div>

      {/* Auto Hide Delay */}
      <div className="ndp-setting-item">
        <label>自动隐藏延迟</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="15000"
            step="1000"
            value={autoHideDelay}
            onChange={(e) => api?.setBubbleSettings({ autoHideDelay: parseInt(e.target.value) })}
          />
          <span>{autoHideDelay === 0 ? '手动关闭' : `${autoHideDelay / 1000}秒`}</span>
        </div>
        <p className="ndp-setting-hint">气泡显示后自动消失的时间，0 表示需要手动关闭</p>
      </div>

      <h3>自定义台词</h3>

      {/* Custom Click Phrases */}
      <div className="ndp-setting-item">
        <label>点击台词</label>
        <textarea
          className="ndp-textarea"
          value={phrasesText}
          placeholder="每行一句台词..."
          rows={6}
          onChange={(e) => handlePhrasesChange(e.target.value)}
          onBlur={handlePhrasesSave}
        />
        <p className="ndp-setting-hint">每行一句，点击桌宠时随机显示（共 {clickPhrases.length} 句）</p>
      </div>
    </div>
  )
}

function TaskPanelSettingsTab(props: {
  api: ReturnType<typeof getApi>
  taskPanelSettings: AppSettings['taskPanel'] | undefined
}) {
  const { api, taskPanelSettings } = props
  const positionX = taskPanelSettings?.positionX ?? 50
  const positionY = taskPanelSettings?.positionY ?? 78

  return (
    <div className="ndp-settings-section">
      <h3>任务面板</h3>
      <p className="ndp-setting-hint">仅在有任务进行中时出现，用于查看进度与暂停/终止。</p>

      <div className="ndp-setting-item">
        <label>水平位置 (X)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionX}
            onChange={(e) => api?.setTaskPanelSettings({ positionX: parseInt(e.target.value) })}
          />
          <span>{positionX}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最左边，100% 为最右边</p>
      </div>

      <div className="ndp-setting-item">
        <label>垂直位置 (Y)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="100"
            step="2"
            value={positionY}
            onChange={(e) => api?.setTaskPanelSettings({ positionY: parseInt(e.target.value) })}
          />
          <span>{positionY}%</span>
        </div>
        <p className="ndp-setting-hint">0% 为最上边，100% 为最下边</p>
      </div>
    </div>
  )
}

// Chat UI Settings Tab Component
function ChatUiSettingsTab(props: { api: ReturnType<typeof getApi>; chatUi: AppSettings['chatUi'] | undefined }) {
  const { api, chatUi } = props

  const background = chatUi?.background ?? 'rgba(20, 20, 24, 0.45)'
  const userBubbleBackground = chatUi?.userBubbleBackground ?? 'rgba(80, 140, 255, 0.22)'
  const assistantBubbleBackground = chatUi?.assistantBubbleBackground ?? 'rgba(0, 0, 0, 0.25)'
  const bubbleRadius = chatUi?.bubbleRadius ?? 14
  const backgroundImage = chatUi?.backgroundImage ?? ''
  const backgroundImageOpacity = chatUi?.backgroundImageOpacity ?? 0.6
  const backgroundImageInputRef = useRef<HTMLInputElement>(null)

  const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))
  const clampFloat = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const parseRgba = (
    value: string,
    fallback: { r: number; g: number; b: number; a: number },
  ): { r: number; g: number; b: number; a: number } => {
    const m = value
      .trim()
      .match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i)
    if (!m) return fallback
    const r = clampInt(parseInt(m[1] || '0'), 0, 255)
    const g = clampInt(parseInt(m[2] || '0'), 0, 255)
    const b = clampInt(parseInt(m[3] || '0'), 0, 255)
    const a = clampFloat(m[4] == null ? 1 : parseFloat(m[4]), 0, 1)
    return { r, g, b, a }
  }

  const toRgba = (rgba: { r: number; g: number; b: number; a: number }) =>
    `rgba(${clampInt(rgba.r, 0, 255)}, ${clampInt(rgba.g, 0, 255)}, ${clampInt(rgba.b, 0, 255)}, ${clampFloat(
      rgba.a,
      0,
      1,
    ).toFixed(2)})`

  const renderRgbaEditor = (opts: {
    label: string
    value: string
    onChange: (next: string) => void
  }) => {
    const rgba = parseRgba(opts.value, { r: 20, g: 20, b: 24, a: 0.45 })

    const set = (next: Partial<typeof rgba>) => {
      const safe: Partial<typeof rgba> = {}
      if (typeof next.r === 'number' && Number.isFinite(next.r)) safe.r = next.r
      if (typeof next.g === 'number' && Number.isFinite(next.g)) safe.g = next.g
      if (typeof next.b === 'number' && Number.isFinite(next.b)) safe.b = next.b
      if (typeof next.a === 'number' && Number.isFinite(next.a)) safe.a = next.a

      const merged = { ...rgba, ...safe }
      opts.onChange(toRgba(merged))
    }

    return (
      <div className="ndp-setting-item">
        <label>{opts.label}</label>
        <div className="ndp-rgba-editor">
          <div className="ndp-rgba-preview" style={{ background: opts.value }} />

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">R</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.r}
              onChange={(e) => set({ r: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">G</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.g}
              onChange={(e) => set({ g: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">B</span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="255"
              value={rgba.b}
              onChange={(e) => set({ b: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-rgba-row">
            <span className="ndp-rgba-key">A</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
            <input
              className="ndp-rgba-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={rgba.a}
              onChange={(e) => set({ a: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
    )
  }

  const readBackgroundFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 5 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => api?.setChatUiSettings({ backgroundImage: String(reader.result || '') })
    reader.readAsDataURL(file)
  }

  return (
    <div className="ndp-settings-section">
      <h3>聊天界面美化</h3>
      <p className="ndp-setting-hint">头像在聊天窗口中点击头像即可更换（不在设置里）。</p>

      {renderRgbaEditor({
        label: '聊天背景 RGBA',
        value: background,
        onChange: (next) => api?.setChatUiSettings({ background: next }),
      })}

      <div className="ndp-setting-item">
        <label>背景图片</label>
        <div className="ndp-bgimg-row">
          <div className="ndp-bgimg-preview">{backgroundImage ? <img src={backgroundImage} alt="bg" /> : <span>无</span>}</div>
          <div className="ndp-bgimg-actions">
            <button className="ndp-btn" onClick={() => backgroundImageInputRef.current?.click()}>
              选择图片
            </button>
            <button
              className="ndp-btn"
              onClick={() => api?.setChatUiSettings({ backgroundImage: '' })}
              disabled={!backgroundImage}
            >
              清除
            </button>
          </div>
        </div>
        <input
          ref={backgroundImageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            readBackgroundFile(file)
            e.currentTarget.value = ''
          }}
        />
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={backgroundImageOpacity}
            onChange={(e) => api?.setChatUiSettings({ backgroundImageOpacity: parseFloat(e.target.value) })}
          />
          <span>{Math.round(backgroundImageOpacity * 100)}%</span>
        </div>
        <p className="ndp-setting-hint">拖动调整背景图片透明度（建议图片小于 5MB）</p>
      </div>

      {renderRgbaEditor({
        label: '用户气泡 RGBA',
        value: userBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ userBubbleBackground: next }),
      })}

      {renderRgbaEditor({
        label: '助手气泡 RGBA',
        value: assistantBubbleBackground,
        onChange: (next) => api?.setChatUiSettings({ assistantBubbleBackground: next }),
      })}

      <div className="ndp-setting-item">
        <label>气泡圆角</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="6"
            max="24"
            step="1"
            value={bubbleRadius}
            onChange={(e) => api?.setChatUiSettings({ bubbleRadius: parseInt(e.target.value) })}
          />
          <span>{bubbleRadius}px</span>
        </div>
      </div>
    </div>
  )
}

function TtsSettingsTab(props: { api: ReturnType<typeof getApi>; ttsSettings: AppSettings['tts'] | undefined }) {
  const { api, ttsSettings } = props

  const enabled = ttsSettings?.enabled ?? false
  const gptWeightsPath = ttsSettings?.gptWeightsPath ?? 'GPT_SoVITS/pretrained_models/s1v3.ckpt'
  const sovitsWeightsPath = ttsSettings?.sovitsWeightsPath ?? 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'
  const speedFactor = ttsSettings?.speedFactor ?? 1.0
  const refAudioPath = ttsSettings?.refAudioPath ?? ''
  const promptText = ttsSettings?.promptText ?? ''
  const streaming = ttsSettings?.streaming ?? true
  const segmented = ttsSettings?.segmented ?? false
  const pauseMs = Math.max(0, Math.min(5000, ttsSettings?.pauseMs ?? 280))

  const [options, setOptions] = useState<
    | {
        gptModels: Array<{ label: string; weightsPath: string }>
        sovitsModels: Array<{ label: string; weightsPath: string }>
        refAudios: Array<{ label: string; value: string; promptText: string }>
        ttsRoot: string
      }
    | null
  >(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const lastOptionsRefreshAtRef = useRef(0)

  const refreshOptions = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!api) return
      const now = Date.now()
      if (!opts?.force && now - lastOptionsRefreshAtRef.current < 800) return
      lastOptionsRefreshAtRef.current = now

      setOptionsError(null)
      try {
        const data = await api.listTtsOptions()
        setOptions(data)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setOptionsError(msg)
      }
    },
    [api],
  )

  useEffect(() => {
    void refreshOptions({ force: true })
  }, [refreshOptions])

  const onSelectRefAudio = (value: string) => {
    const selected = options?.refAudios?.find((x) => x.value === value)
    api?.setTtsSettings({
      refAudioPath: value,
      promptText: selected?.promptText ?? promptText,
    })
  }

  return (
    <div className="ndp-settings-section">
      <h3>TTS 语音</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setTtsSettings({ enabled: e.target.checked })} />
          <span>启用 TTS（助手消息自动播报）</span>
        </label>
        <p className="ndp-setting-hint">需要先启动 `GPT-SoVITS-v2_ProPlus` 的 API 服务（默认: http://127.0.0.1:9880）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>GPT 模型</label>
        <select
          className="ndp-select"
          value={gptWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ gptWeightsPath: e.target.value })}
        >
          {(options?.gptModels?.length ?? 0) > 0 ? (
            options!.gptModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={gptWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
      </div>

      <div className="ndp-setting-item">
        <label>SoVITS 模型</label>
        <select
          className="ndp-select"
          value={sovitsWeightsPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => api?.setTtsSettings({ sovitsWeightsPath: e.target.value })}
        >
          {(options?.sovitsModels?.length ?? 0) > 0 ? (
            options!.sovitsModels.map((m) => (
              <option key={m.weightsPath} value={m.weightsPath}>
                {m.label}
              </option>
            ))
          ) : (
            <option value={sovitsWeightsPath}>（未扫描到，使用当前配置）</option>
          )}
        </select>
        <p className="ndp-setting-hint">默认“直接推底模”只需要设置参考音频即可。</p>
      </div>

      <div className="ndp-setting-item">
        <label>语速</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={speedFactor}
            onChange={(e) => api?.setTtsSettings({ speedFactor: parseFloat(e.target.value) })}
          />
          <span>{speedFactor.toFixed(2)}x</span>
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频</label>
        <select
          className="ndp-select"
          value={refAudioPath}
          onMouseDown={() => void refreshOptions()}
          onFocus={() => void refreshOptions()}
          onChange={(e) => onSelectRefAudio(e.target.value)}
        >
          <option value="">请选择（从 `参考音频` 目录扫描）</option>
          {(options?.refAudios ?? []).map((a) => (
            <option key={a.value} value={a.value} title={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="ndp-setting-hint">下拉框仅显示文件名里 `[]` 内的内容（例如角色名）。</p>
      </div>

      <div className="ndp-setting-item">
        <label>参考音频文本（自动从文件名解析，可编辑）</label>
        <textarea
          className="ndp-textarea"
          value={promptText}
          rows={3}
          placeholder="例如：该做的事都做完了么？好，别睡下了才想起来日常没做，拜拜。"
          onChange={(e) => api?.setTtsSettings({ promptText: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={streaming} onChange={(e) => api?.setTtsSettings({ streaming: e.target.checked })} />
          <span>流式处理（边生成边播放）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={segmented} onChange={(e) => api?.setTtsSettings({ segmented: e.target.checked })} />
          <span>分句同步显示（TTS 念一句，聊天/气泡显示一句）</span>
        </label>
      </div>

      <div className="ndp-setting-item">
        <label>分句停顿（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="1200"
            step="20"
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0}
            max={5000}
            step={20}
            value={pauseMs}
            onChange={(e) => api?.setTtsSettings({ pauseMs: parseInt(e.target.value || '0') })}
          />
        </div>
      </div>

      {options?.ttsRoot ? <p className="ndp-setting-hint">扫描目录: {options.ttsRoot}</p> : null}
      {optionsError ? <p className="ndp-setting-hint">扫描失败: {optionsError}</p> : null}
    </div>
  )
}

function AsrSettingsTab(props: { api: ReturnType<typeof getApi>; asrSettings: AppSettings['asr'] | undefined }) {
  const { api, asrSettings } = props

  const enabled = asrSettings?.enabled ?? false
  const wsUrl = asrSettings?.wsUrl ?? 'ws://127.0.0.1:8766/ws'
  const micDeviceId = asrSettings?.micDeviceId ?? ''
  const language = asrSettings?.language ?? 'auto'
  const useItn = asrSettings?.useItn ?? true
  const autoSend = asrSettings?.autoSend ?? false

  const vadChunkMs = Math.max(40, Math.min(800, asrSettings?.vadChunkMs ?? 200))
  const maxEndSilenceMs = Math.max(80, Math.min(4000, asrSettings?.maxEndSilenceMs ?? 800))
  const minSpeechMs = Math.max(0, Math.min(5000, asrSettings?.minSpeechMs ?? 600))
  const maxSpeechMs = Math.max(800, Math.min(60000, asrSettings?.maxSpeechMs ?? 15000))
  const prerollMs = Math.max(0, Math.min(2000, asrSettings?.prerollMs ?? 120))
  const postrollMs = Math.max(0, Math.min(2000, asrSettings?.postrollMs ?? 80))

  const enableAgc = asrSettings?.enableAgc ?? true
  const agcTargetRms = Math.max(0.005, Math.min(0.2, asrSettings?.agcTargetRms ?? 0.05))
  const agcMaxGain = Math.max(1, Math.min(80, asrSettings?.agcMaxGain ?? 20))
  const debug = asrSettings?.debug ?? false

  const applyInt = (value: string, fallback: number) => {
    const n = parseInt(value || '', 10)
    return Number.isFinite(n) ? n : fallback
  }

  const applyFloat = (value: string, fallback: number) => {
    const n = parseFloat(value || '')
    return Number.isFinite(n) ? n : fallback
  }

  const [micDevices, setMicDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const [micLoading, setMicLoading] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const refreshMicDevices = useCallback(async () => {
    setMicLoading(true)
    setMicError(null)

    try {
      if (!navigator.mediaDevices) {
        setMicDevices([])
        setMicError('当前环境不支持枚举音频设备')
        return
      }

      // 先请求一次权限，否则 device.label 可能为空，且部分环境 enumerateDevices 不完整
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `麦克风（${d.deviceId.slice(0, 6)}…）` }))
        setMicDevices(mics)
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMicDevices([])
      setMicError(msg)
    } finally {
      setMicLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshMicDevices()
  }, [refreshMicDevices])

  return (
    <div className="ndp-settings-section">
      <h3>语音识别（ASR）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => api?.setAsrSettings({ enabled: e.target.checked })} />
          <span>启用语音识别（麦克风转文字）</span>
        </label>
        <p className="ndp-setting-hint">
          需要先启动本地 ASR 服务端（推荐：WebSocket 实时音频流 + FSMN-VAD 断句 + SenseVoiceSmall 转写）。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>WebSocket 地址</label>
        <input type="text" className="ndp-input" value={wsUrl} onChange={(e) => api?.setAsrSettings({ wsUrl: e.target.value })} />
        <p className="ndp-setting-hint">示例：ws://127.0.0.1:8766/ws（默认端口 8766）</p>
      </div>

      <div className="ndp-setting-item">
        <label>选择麦克风</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            className="ndp-select"
            style={{ flex: 1 }}
            value={micDeviceId}
            onMouseDown={() => refreshMicDevices()}
            onFocus={() => refreshMicDevices()}
            onChange={(e) => api?.setAsrSettings({ micDeviceId: e.target.value })}
          >
            <option value="">系统默认</option>
            {micDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} title={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ndp-btn" onClick={() => refreshMicDevices()} disabled={micLoading} type="button">
            {micLoading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <p className="ndp-setting-hint">
          如果下拉框为空或无法选择，先点一次“刷新”并允许麦克风权限；设备名称只有在授权后才会显示
        </p>
        {micError ? <p className="ndp-setting-hint">刷新失败：{micError}</p> : null}
      </div>

      <div className="ndp-setting-item">
        <label>识别语言</label>
        <select className="ndp-select" value={language} onChange={(e) => api?.setAsrSettings({ language: e.target.value as AppSettings['asr']['language'] })}>
          <option value="auto">自动 (auto)</option>
          <option value="zn">中文 (zn)</option>
          <option value="yue">粤语 (yue)</option>
          <option value="en">英文 (en)</option>
          <option value="ja">日文 (ja)</option>
          <option value="ko">韩文 (ko)</option>
          <option value="nospeech">无语音 (nospeech)</option>
        </select>
        <p className="ndp-setting-hint">建议默认 auto；如果混识别，可固定为 zn/en 等</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={useItn} onChange={(e) => api?.setAsrSettings({ useItn: e.target.checked })} />
          <span>标点/ITN（更像输入法）</span>
        </label>
        <p className="ndp-setting-hint">开启后会自动补标点、数字等格式化，通常更可读</p>
      </div>

      <h3>识别结果处理</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="radio" name="asrSendMode" checked={autoSend} onChange={() => api?.setAsrSettings({ autoSend: true })} />
          <span>直接发送（识别完自动发给 LLM）</span>
        </label>
        <label className="ndp-checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="radio"
            name="asrSendMode"
            checked={!autoSend}
            onChange={() => api?.setAsrSettings({ autoSend: false })}
          />
          <span>仅在输入框（识别完只填入输入框，手动发送）</span>
        </label>
        <p className="ndp-setting-hint">开启“直接发送”后，会把每次端点结束的一段识别结果作为一条用户消息发送</p>
      </div>

      <h3>端点检测（VAD）</h3>

      <div className="ndp-setting-item">
        <label>VAD 分块大小（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="40"
            max="500"
            step="10"
            value={vadChunkMs}
            onChange={(e) => api?.setAsrSettings({ vadChunkMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={40}
            max={500}
            step={10}
            value={vadChunkMs}
            onChange={(e) => api?.setAsrSettings({ vadChunkMs: applyInt(e.target.value, vadChunkMs) })}
          />
        </div>
        <p className="ndp-setting-hint">越小越低延迟，但 CPU 开销更高；建议 160-240ms</p>
      </div>

      <div className="ndp-setting-item">
        <label>尾部静音判停（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="200"
            max="2000"
            step="20"
            value={maxEndSilenceMs}
            onChange={(e) => api?.setAsrSettings({ maxEndSilenceMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={80}
            max={4000}
            step={20}
            value={maxEndSilenceMs}
            onChange={(e) => api?.setAsrSettings({ maxEndSilenceMs: applyInt(e.target.value, maxEndSilenceMs) })}
          />
        </div>
        <p className="ndp-setting-hint">过低易截断，过高会“停得慢”；普通说话建议 600-1000ms</p>
      </div>

      <div className="ndp-setting-item">
        <label>最短语音段（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="2000"
            step="20"
            value={minSpeechMs}
            onChange={(e) => api?.setAsrSettings({ minSpeechMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0}
            max={5000}
            step={20}
            value={minSpeechMs}
            onChange={(e) => api?.setAsrSettings({ minSpeechMs: applyInt(e.target.value, minSpeechMs) })}
          />
        </div>
        <p className="ndp-setting-hint">用于过滤短噪声（键盘、鼠标、喷麦）；太大可能漏掉短词</p>
      </div>

      <div className="ndp-setting-item">
        <label>最长语音段（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="2000"
            max="30000"
            step="200"
            value={maxSpeechMs}
            onChange={(e) => api?.setAsrSettings({ maxSpeechMs: parseInt(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={800}
            max={60000}
            step={200}
            value={maxSpeechMs}
            onChange={(e) => api?.setAsrSettings({ maxSpeechMs: applyInt(e.target.value, maxSpeechMs) })}
          />
        </div>
        <p className="ndp-setting-hint">超长句会强制切分，避免一直不出结果；建议 10-20 秒</p>
      </div>

      <div className="ndp-setting-item">
        <label>起点预留 / 终点补偿（ms）</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            value={prerollMs}
            onChange={(e) => api?.setAsrSettings({ prerollMs: parseInt(e.target.value) })}
          />
          <span>起点 {prerollMs}ms</span>
        </div>
        <div className="ndp-range-input" style={{ marginTop: 8 }}>
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            value={postrollMs}
            onChange={(e) => api?.setAsrSettings({ postrollMs: parseInt(e.target.value) })}
          />
          <span>终点 {postrollMs}ms</span>
        </div>
        <p className="ndp-setting-hint">防止吞掉开头/结尾的辅音；太大可能把环境音也带进去</p>
      </div>

      <h3>音量处理</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enableAgc} onChange={(e) => api?.setAsrSettings({ enableAgc: e.target.checked })} />
          <span>自动增益（AGC）</span>
        </label>
        <p className="ndp-setting-hint">当麦克风声音太小时自动放大，提升识别稳定性；如果容易爆音/喷麦可关闭</p>
      </div>

      <div className="ndp-setting-item">
        <label>AGC 目标 RMS / 最大增益</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0.01"
            max="0.12"
            step="0.005"
            value={agcTargetRms}
            onChange={(e) => api?.setAsrSettings({ agcTargetRms: parseFloat(e.target.value) })}
          />
          <input
            className="ndp-input"
            style={{ width: 96 }}
            type="number"
            min={0.005}
            max={0.2}
            step={0.005}
            value={agcTargetRms}
            onChange={(e) => api?.setAsrSettings({ agcTargetRms: applyFloat(e.target.value, agcTargetRms) })}
          />
        </div>
        <div className="ndp-range-input" style={{ marginTop: 8 }}>
          <input
            type="range"
            min="1"
            max="40"
            step="1"
            value={agcMaxGain}
            onChange={(e) => api?.setAsrSettings({ agcMaxGain: parseInt(e.target.value) })}
          />
          <span>{agcMaxGain}x</span>
        </div>
        <p className="ndp-setting-hint">目标 RMS 建议 0.03-0.08；最大增益建议 10-30x</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={debug} onChange={(e) => api?.setAsrSettings({ debug: e.target.checked })} />
          <span>调试日志</span>
        </label>
        <p className="ndp-setting-hint">开启后服务端/前端会输出更多处理信息，便于定位断句与识别问题</p>
      </div>
    </div>
  )
}

// AI Settings Tab Component
function AISettingsTab(props: {
  api: ReturnType<typeof getApi>
  aiSettings: AppSettings['ai'] | undefined
}) {
  const { api, aiSettings } = props

  const apiKey = aiSettings?.apiKey ?? ''
  const baseUrl = aiSettings?.baseUrl ?? 'https://api.openai.com/v1'
  const model = aiSettings?.model ?? 'gpt-4o-mini'
  const temperature = aiSettings?.temperature ?? 0.7
  const maxTokens = aiSettings?.maxTokens ?? 64000
  const maxContextTokens = aiSettings?.maxContextTokens ?? 128000
  const systemPrompt = aiSettings?.systemPrompt ?? ''
  const enableVision = aiSettings?.enableVision ?? false
  const enableChatStreaming = aiSettings?.enableChatStreaming ?? false

  // Format large numbers for display
  const formatTokens = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}K`
    return String(n)
  }

  return (
    <div className="ndp-settings-section">
      <h3>API 设置</h3>

      {/* API Key */}
      <div className="ndp-setting-item">
        <label>API Key</label>
        <input
          type="password"
          className="ndp-input"
          value={apiKey}
          placeholder="sk-..."
          onChange={(e) => api?.setAISettings({ apiKey: e.target.value })}
        />
        <p className="ndp-setting-hint">支持 OpenAI 兼容的 API</p>
      </div>

      {/* Base URL */}
      <div className="ndp-setting-item">
        <label>API Base URL</label>
        <input
          type="text"
          className="ndp-input"
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => api?.setAISettings({ baseUrl: e.target.value })}
        />
        <p className="ndp-setting-hint">可配置代理或其他兼容 API 地址</p>
      </div>

      {/* Model */}
      <div className="ndp-setting-item">
        <label>模型名称</label>
        <input
          type="text"
          className="ndp-input"
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(e) => api?.setAISettings({ model: e.target.value })}
        />
        <p className="ndp-setting-hint">输入模型 ID，如 gpt-4o、claude-3-5-sonnet 等</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableVision}
            onChange={(e) => api?.setAISettings({ enableVision: e.target.checked })}
          />
          <span>启用识图能力（发送图片）</span>
        </label>
        <p className="ndp-setting-hint">部分模型不支持图片输入，关闭后聊天窗口将禁用“图片”按钮</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={enableChatStreaming}
            onChange={(e) => api?.setAISettings({ enableChatStreaming: e.target.checked })}
          />
          <span>聊天流式生成（逐步输出）</span>
        </label>
        <p className="ndp-setting-hint">开启后会以 SSE 方式逐步生成文本；若同时开启 TTS 分句同步，会按句子分段出现</p>
      </div>

      <h3>生成设置</h3>

      {/* Temperature */}
      <div className="ndp-setting-item">
        <label>温度 (Temperature)</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => api?.setAISettings({ temperature: parseFloat(e.target.value) })}
          />
          <span>{temperature.toFixed(1)}</span>
        </div>
        <p className="ndp-setting-hint">较低值更确定，较高值更有创意</p>
      </div>

      {/* Max Tokens */}
      <div className="ndp-setting-item">
        <label>最大回复长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="1000"
            max="128000"
            step="1000"
            value={maxTokens}
            onChange={(e) => api?.setAISettings({ maxTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxTokens)}</span>
        </div>
        <p className="ndp-setting-hint">AI 单次回复的最大 token 数量</p>
      </div>

      {/* Max Context Tokens */}
      <div className="ndp-setting-item">
        <label>最大上下文长度</label>
        <div className="ndp-range-input">
          <input
            type="range"
            min="4000"
            max="1000000"
            step="4000"
            value={maxContextTokens}
            onChange={(e) => api?.setAISettings({ maxContextTokens: parseInt(e.target.value) })}
          />
          <span>{formatTokens(maxContextTokens)}</span>
        </div>
        <p className="ndp-setting-hint">对话历史的最大 token 数量</p>
      </div>

      {/* System Prompt */}
      <div className="ndp-setting-item">
        <label>系统提示词</label>
        <textarea
          className="ndp-textarea"
          value={systemPrompt}
          placeholder="你是一个可爱的桌面宠物助手..."
          rows={4}
          onChange={(e) => api?.setAISettings({ systemPrompt: e.target.value })}
        />
        <p className="ndp-setting-hint">定义 AI 的角色和行为</p>
      </div>
    </div>
  )
}
