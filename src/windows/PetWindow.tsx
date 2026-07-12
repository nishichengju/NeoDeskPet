// 桌宠主窗口：Live2D 渲染、气泡、ASR、拖拽与任务面板（自 App.tsx 拆出）

import type { AppSettings, ContextUsageSnapshot, TaskRecord } from '../../electron/types'
import { ContextUsageOrb } from '../components/ContextUsageOrb'
import { SpeechBubble } from '../components/SpeechBubble'
import { Live2DView } from '../live2d/Live2DView'
import { parseModelMetadata } from '../live2d/live2dModels'
import { getApi } from '../neoDeskPetApi'
import { TtsPlayer } from '../services/ttsService'
import { applyAsrLocalRules, createOpenTypelessPcmSender, waitForOpenTypelessAsrReady } from '../utils/asrAudio'
import { BUBBLE_PREVIEW_FALLBACK_PREFIX, filterVisibleToolRuns } from '../utils/chatMessages'
import { isOpenTypelessAsrWsUrl } from '../utils/settingsHelpers'
import { resolveTtsPlaybackText, trimTrailingCommaForSegment } from '../utils/ttsText'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

export function PetWindow() {
  const api = useMemo(() => getApi(), [])
  const isDragging = useRef(false)
  const [windowDragging, setWindowDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isOverModel = useRef(true)
  const clickStartTime = useRef(0)
  const dragPointerId = useRef<number | null>(null)
  const lastDragPoint = useRef<{ x: number; y: number } | null>(null)
  const dragMoveRafRef = useRef<number>(0)
  const pendingDragPointRef = useRef<{ x: number; y: number } | null>(null)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const ttsPlayerRef = useRef<TtsPlayer | null>(null)
  const bubbleTtsQueueRef = useRef<string[]>([])
  const bubbleTtsRunningRef = useRef(false)
  const ttsQueueRef = useRef<
    { utteranceId: string; segments: string[]; finalized: boolean; playIndex: number } | null
  >(null)
  const ttsQueueWakeRef = useRef<(() => void) | null>(null)
  const ttsQueueRunningRef = useRef(false)
  const ttsActiveUtteranceRef = useRef<string | null>(null)
  const [mouthOpen, setMouthOpen] = useState(0)
  type BubbleUiPayload = {
    text: string
    startAt: number | null
    mode: 'typing' | 'append'
    autoHideDelay?: number
    animateAppend?: boolean
    resetAppendFromEmpty?: boolean
  }
  const [bubblePayload, setBubblePayload] = useState<BubbleUiPayload | null>(null)
  const [bubblePinnedPayload, setBubblePinnedPayload] = useState<(BubbleUiPayload & { id: number }) | null>(null)
  const bubblePayloadRef = useRef<BubbleUiPayload | null>(null)
  const bubblePinnedPayloadRef = useRef<(BubbleUiPayload & { id: number }) | null>(null)
  const bubblePinnedSeqRef = useRef(0)
  const bubblePreviewActiveRef = useRef(false)
  const bubblePreviewStartAtRef = useRef<number | null>(null)
  const bubblePreviewTextRef = useRef('')
  const bubblePreviewDebugAtRef = useRef(0)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null)
  const toolAnimRef = useRef<{ motionGroups: string[]; expressions: string[] }>({ motionGroups: [], expressions: [] })
  const taskPanelRef = useRef<HTMLDivElement | null>(null)

  // 默认不提供任何“固定人设台词”，避免与 AI 设置里的人设割裂
  const defaultPhrases: string[] = []

  const [asrSubtitle, setAsrSubtitle] = useState<string>('')
  const [asrRecording, setAsrRecording] = useState(false)
  const asrSubtitleHideTimerRef = useRef<number | null>(null)

  const asrClientRef = useRef<{
    ws: WebSocket
    protocol: 'legacy' | 'opentypeless'
    mediaStream: MediaStream
    audioContext: AudioContext
    node: AudioNode
    sink: GainNode
    stopFeeder: () => void
    sampleRate: number
  } | null>(null)
  const asrStartingRef = useRef(false)
  const asrStartKindRef = useRef<'continuous' | 'hotkey' | null>(null)
  const asrFinalSegmentsRef = useRef<string[]>([])
  const asrPartialRef = useRef<string>('')
  const asrComposeBaseTextRef = useRef<string>('')
  const asrComposeBaseControlledRef = useRef(false)

  const clearAsrSubtitleTimer = useCallback(() => {
    if (asrSubtitleHideTimerRef.current) {
      window.clearTimeout(asrSubtitleHideTimerRef.current)
      asrSubtitleHideTimerRef.current = null
    }
  }, [])

  const buildAsrCompositeSubtitle = useCallback(() => {
    const hasExternalBaseControl = asrComposeBaseControlledRef.current
    const externalBase = hasExternalBaseControl ? asrComposeBaseTextRef.current.trim() : ''
    const finals = asrFinalSegmentsRef.current.map((s) => s.trim()).filter(Boolean)
    const partial = asrPartialRef.current.trim()
    // 只要聊天窗口已接管“累计基线”，即使基线被清空为 ''，也不能回退到本地 finals，
    // 否则会出现“输入框清空了但字幕还显示旧累计”的错位。
    if (hasExternalBaseControl) return partial ? `${externalBase} ${partial}`.trim() : externalBase
    if (finals.length > 0 && partial) return `${finals.join(' ')} ${partial}`.trim()
    if (finals.length > 0) return finals.join(' ').trim()
    return partial
  }, [])

  const showAsrSubtitle = useCallback(
    (text: string, options?: { autoHideMs?: number }) => {
      clearAsrSubtitleTimer()

      const asr = settingsRef.current?.asr
      if (!asr?.showSubtitle) return

      setAsrSubtitle(text)
      const ms = Math.max(0, Math.min(30000, Math.floor(options?.autoHideMs ?? 0)))
      if (ms > 0) {
        asrSubtitleHideTimerRef.current = window.setTimeout(() => {
          asrSubtitleHideTimerRef.current = null
          setAsrSubtitle('')
        }, ms)
      }
    },
    [clearAsrSubtitleTimer],
  )

  const syncAsrCompositeSubtitle = useCallback(
    (options?: { autoHideMs?: number }) => {
      showAsrSubtitle(buildAsrCompositeSubtitle(), options)
    },
    [buildAsrCompositeSubtitle, showAsrSubtitle],
  )

  const stopAsr = useCallback(() => {
    const client = asrClientRef.current
    if (!client) {
      asrStartingRef.current = false
      asrStartKindRef.current = null
      setAsrRecording(false)
      return
    }
    asrClientRef.current = null
    asrStartingRef.current = false
    asrStartKindRef.current = null
    setAsrRecording(false)

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
      if (client.protocol === 'opentypeless' && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send('stop')
        window.setTimeout(() => {
          try {
            client.ws.close()
          } catch (_) {
            /* ignore */
          }
        }, 120)
      } else {
        client.ws.close()
      }
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
    if (isOpenTypelessAsrWsUrl(asr.wsUrl)) return

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

  const handleAsrWsText = useCallback(
    (raw: string) => {
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      const msg = payload as { type?: string; text?: string; message?: string; error?: string }
      const msgTypeRaw = String(msg.type ?? '').trim()
      const msgType = msgTypeRaw.toLowerCase()
      const msgTypeNorm = msgType.replace(/[^a-z]/g, '')
      const text = String(msg.text ?? '').trim()

      if (
        msgTypeNorm === 'partial' ||
        msgTypeNorm === 'partialresult' ||
        msgTypeNorm === 'interim' ||
        msgTypeNorm === 'interimresult' ||
        msgTypeNorm === 'midresult' ||
        msgTypeNorm === 'intermediateresult' ||
        (msgTypeNorm.includes('partial') && msgTypeNorm.includes('result'))
      ) {
        const asr = settingsRef.current?.asr
        const interimText = applyAsrLocalRules(text, asr, { forInterim: true })
        asrPartialRef.current = interimText
        syncAsrCompositeSubtitle()
        return
      }

      if (
        msgTypeNorm === 'result' ||
        msgTypeNorm === 'final' ||
        msgTypeNorm === 'finalresult' ||
        (msgTypeNorm.includes('final') && msgTypeNorm.includes('result'))
      ) {
        asrPartialRef.current = ''
        if (!text) return

        const asr = settingsRef.current?.asr
        const finalText = applyAsrLocalRules(text, asr, { forInterim: false })
        if (!finalText) return
        const mode = asr?.mode ?? 'continuous'
        if (mode === 'hotkey') {
          asrFinalSegmentsRef.current.push(finalText)
          syncAsrCompositeSubtitle()
          return
        }

        const autoSend = Boolean(asr?.autoSend)
        if (!autoSend) {
          asrFinalSegmentsRef.current.push(finalText)
        }

        // continuous: 保持“最终结果 + 当前中间结果”连续显示，避免新一段中间结果覆盖已确认文本。
        syncAsrCompositeSubtitle({ autoHideMs: 6000 })
        try {
          api?.reportAsrTranscript(finalText)
        } catch (_) {
          /* ignore */
        }
        if (autoSend) {
          asrFinalSegmentsRef.current = []
          syncAsrCompositeSubtitle({ autoHideMs: 0 })
        }
        return
      }

      if (msgTypeNorm === 'error') {
        const errText = String(msg.error ?? msg.message ?? msg.text ?? '').trim()
        if (errText) showAsrSubtitle(`ASR 错误：${errText}`, { autoHideMs: 5000 })
        return
      }

      if (msgTypeNorm === 'ready') {
        if (settingsRef.current?.asr?.debug ?? false) {
          console.debug('[ASR] ready', payload)
        }
        return
      }

      if (msgTypeNorm === 'debug' || msgTypeNorm === 'log') {
        const hint = String(msg.message ?? msg.error ?? '').trim()
        if (hint && (settingsRef.current?.asr?.debug ?? false)) {
          console.debug('[ASR]', hint)
        }
      }
    },
    [api, showAsrSubtitle, syncAsrCompositeSubtitle],
  )

  const startAsr = useCallback(async () => {
    const asr = settingsRef.current?.asr
    if (!asr?.enabled) return
    if (asrClientRef.current) return
    if (asrStartingRef.current) return
    asrStartingRef.current = true

    try {
      const wsUrl = asr.wsUrl.trim()
      if (!wsUrl) {
        showAsrSubtitle('ASR WebSocket 地址为空', { autoHideMs: 4000 })
        return
      }
      const useOpenTypelessWs = isOpenTypelessAsrWsUrl(wsUrl)
      asrFinalSegmentsRef.current = []
      asrPartialRef.current = ''

      if (useOpenTypelessWs) {
        showAsrSubtitle('ASR API 启动中…')
        const ready = await waitForOpenTypelessAsrReady(wsUrl, { timeoutMs: 30_000 })
        if (!ready) {
          showAsrSubtitle('ASR API 启动超时', { autoHideMs: 5000 })
          return
        }
        if (!(settingsRef.current?.asr?.enabled ?? false)) return
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

        // 优先尝试 exact；失败时尝试 ideal；再失败回退系统默认
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

      // OpenTypeless 实时 ws 默认使用 16kHz PCM16，优先直接请求 16k 采样率以减少前端重采样开销。
      let audioContext: AudioContext
      try {
        audioContext = useOpenTypelessWs ? new AudioContext({ sampleRate: 16000 }) : new AudioContext()
      } catch {
        audioContext = new AudioContext()
      }
      const sampleRate = audioContext.sampleRate || 48000

      const source = audioContext.createMediaStreamSource(mediaStream)

      // 避免把麦克风音频直通到扬声器造成回声/啸叫
      const sink = audioContext.createGain()
      sink.gain.value = 0
      sink.connect(audioContext.destination)

      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'

      const bufferSize = 4096

      const sendPcm = useOpenTypelessWs
        ? createOpenTypelessPcmSender(ws, sampleRate)
        : (pcm: Float32Array) => {
            if (ws.readyState !== WebSocket.OPEN) return
            const copy = new Float32Array(pcm.length)
            copy.set(pcm)
            ws.send(copy.buffer)
          }

      let node: AudioNode
      let stopFeeder: () => void

      const tryCreateWorklet = async () => {
        const backend = (settingsRef.current?.asr?.captureBackend ?? 'auto') as 'auto' | 'script' | 'worklet'
        if (backend === 'script') return null
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
          outputChannelCount: [1],
        })

        workletNode.port.onmessage = (ev) => {
          const buf = ev.data
          if (buf instanceof Float32Array) {
            sendPcm(buf)
            return
          }
          if (buf instanceof ArrayBuffer) {
            sendPcm(new Float32Array(buf))
          }
        }

        source.connect(workletNode)
        workletNode.connect(sink)

        const stop = () => {
          try {
            workletNode.port.onmessage = null
          } catch (_) {
            /* ignore */
          }
          try {
            source.disconnect(workletNode)
          } catch (_) {
            /* ignore */
          }
          try {
            workletNode.disconnect()
          } catch (_) {
            /* ignore */
          }
        }

        return { node: workletNode, stop }
      }

      const created = await (async () => {
        const backend = (settingsRef.current?.asr?.captureBackend ?? 'auto') as 'auto' | 'script' | 'worklet'
        if (backend === 'worklet' && !audioContext.audioWorklet) {
          showAsrSubtitle('当前环境不支持 AudioWorklet，已回退为 ScriptProcessor', { autoHideMs: 4000 })
          return null
        }
        return tryCreateWorklet()
      })()
      if (created) {
        node = created.node
        stopFeeder = created.stop
      } else {
        const proc = audioContext.createScriptProcessor(bufferSize, 1, 1)
        proc.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0)
          sendPcm(input)
        }
        source.connect(proc)
        proc.connect(sink)

        node = proc
        stopFeeder = () => {
          try {
            proc.onaudioprocess = null
          } catch (_) {
            /* ignore */
          }
          try {
            source.disconnect(proc)
          } catch (_) {
            /* ignore */
          }
          try {
            proc.disconnect()
          } catch (_) {
            /* ignore */
          }
        }
      }

      ws.addEventListener('open', () => {
        sendAsrConfig()
        setAsrRecording(true)
        showAsrSubtitle('录音中…')
      })
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          handleAsrWsText(ev.data)
          return
        }
        if (ev.data instanceof ArrayBuffer) {
          try {
            const text = new TextDecoder('utf-8').decode(new Uint8Array(ev.data))
            handleAsrWsText(text)
          } catch {
            /* ignore */
          }
        }
      })
      ws.addEventListener('error', () => {
        showAsrSubtitle('ASR 连接失败', { autoHideMs: 4000 })
      })
      ws.addEventListener('close', () => {
        if (asrClientRef.current?.ws === ws) {
          asrClientRef.current = null
          setAsrRecording(false)
        }
      })

      asrClientRef.current = {
        ws,
        protocol: useOpenTypelessWs ? 'opentypeless' : 'legacy',
        mediaStream,
        audioContext,
        node,
        sink,
        stopFeeder,
        sampleRate,
      }
      showAsrSubtitle('ASR 连接中…')
    } finally {
      asrStartingRef.current = false
    }
  }, [handleAsrWsText, sendAsrConfig, showAsrSubtitle])

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  useEffect(() => {
    if (!api) return
    let disposed = false
    api
      .getContextUsage()
      .then((snap) => {
        if (disposed) return
        setContextUsage(snap)
      })
      .catch(() => {
        /* ignore */
      })
    const off = api.onContextUsageChanged((snap) => {
      if (disposed) return
      setContextUsage(snap)
    })
    return () => {
      disposed = true
      off()
    }
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

  // Task (agent.run) 最终回复里携带的 Live2D 标签：优先按 LLM 指定的表情/动作触发（不再退化为“总是第一个”）
  const taskLive2dInitRef = useRef(false)
  const lastTaskLive2dRef = useRef<Map<string, { expression?: string; motion?: string }>>(new Map())
  useEffect(() => {
    if (!api) return

    const expressions = toolAnimRef.current.expressions ?? []
    const motions = toolAnimRef.current.motionGroups ?? []
    const normalize = (s: unknown) => String(s ?? '').trim()

    const resolveExpression = (nameRaw: string): string | null => {
      const name = normalize(nameRaw)
      if (!name) return null
      if (expressions.includes(name)) return name
      const lower = name.toLowerCase()
      const hit = expressions.find((e) => e.toLowerCase() === lower) ?? null
      return hit
    }

    const resolveMotion = (nameRaw: string): string | null => {
      const name = normalize(nameRaw)
      if (!name) return null
      if (motions.includes(name)) return name
      const lower = name.toLowerCase()
      const hit = motions.find((m) => m.toLowerCase() === lower) ?? null
      return hit
    }

    const next = new Map<string, { expression?: string; motion?: string }>()

    for (const t of tasks) {
      const expression = normalize((t as unknown as { live2dExpression?: unknown }).live2dExpression) || undefined
      const motion = normalize((t as unknown as { live2dMotion?: unknown }).live2dMotion) || undefined
      next.set(t.id, { expression, motion })

      if (!taskLive2dInitRef.current) continue

      const prev = lastTaskLive2dRef.current.get(t.id)
      if (expression && expression !== prev?.expression) {
        const exp = resolveExpression(expression)
        if (exp) api.triggerExpression(exp)
      }
      if (motion && motion !== prev?.motion) {
        const m = resolveMotion(motion)
        if (m) api.triggerMotion(m, 0)
      }
    }

    lastTaskLive2dRef.current = next
    if (!taskLive2dInitRef.current) taskLive2dInitRef.current = true
  }, [api, tasks])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    bubblePayloadRef.current = bubblePayload
  }, [bubblePayload])

  useEffect(() => {
    bubblePinnedPayloadRef.current = bubblePinnedPayload
  }, [bubblePinnedPayload])

  const asrEnabled = settings?.asr?.enabled ?? false
  const asrMode = settings?.asr?.mode ?? 'continuous'
  const asrWsUrl = settings?.asr?.wsUrl ?? ''
  const asrMicDeviceId = settings?.asr?.micDeviceId ?? ''
  const asrShowSubtitle = settings?.asr?.showSubtitle ?? true

  useEffect(() => {
    if (!asrShowSubtitle) {
      setAsrSubtitle('')
      clearAsrSubtitleTimer()
    }
  }, [asrShowSubtitle, clearAsrSubtitleTimer])

  useEffect(() => {
    if (!api) return
    return api.onAsrComposePreview((payload) => {
      const baseText = typeof payload?.baseText === 'string' ? payload.baseText : ''
      asrComposeBaseControlledRef.current = true
      asrComposeBaseTextRef.current = baseText
      if (payload?.clearFinals) {
        asrFinalSegmentsRef.current = []
      }
      syncAsrCompositeSubtitle()
    })
  }, [api, syncAsrCompositeSubtitle])

  // hotkey toggle: press once to start, press again to stop (only when mode=hotkey)
  useEffect(() => {
    if (!api) return

    return api.onAsrHotkeyToggle(() => {
      const asr = settingsRef.current?.asr
      if (!asr?.enabled) return
      if ((asr.mode ?? 'continuous') !== 'hotkey') return

      if (asrClientRef.current) {
        stopAsr()
        const parts = [...asrFinalSegmentsRef.current]
        if (asrPartialRef.current.trim()) parts.push(asrPartialRef.current.trim())
        asrFinalSegmentsRef.current = []
        asrPartialRef.current = ''

        const finalText = parts.join(' ').trim()
        if (finalText) {
          try {
            api.reportAsrTranscript(finalText)
          } catch (_) {
            /* ignore */
          }
          showAsrSubtitle(finalText, { autoHideMs: 6000 })
        } else {
          showAsrSubtitle('', { autoHideMs: 0 })
        }
        return
      }

      asrFinalSegmentsRef.current = []
      asrPartialRef.current = ''
      asrStartKindRef.current = 'hotkey'
      void startAsr().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[ASR] start failed:', msg)
        showAsrSubtitle('ASR 启动失败', { autoHideMs: 4000 })
        stopAsr()
      })
    })
  }, [api, showAsrSubtitle, startAsr, stopAsr])

  // continuous mode: start/stop with switch (no hotkey needed)
  useEffect(() => {
    if (!asrEnabled) {
      stopAsr()
      return
    }

    if (asrMode !== 'continuous') {
      if (asrStartKindRef.current === 'continuous') stopAsr()
      return
    }

    if (asrStartKindRef.current !== 'continuous') {
      stopAsr()
      asrStartKindRef.current = 'continuous'
    }

    void startAsr().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[ASR] start failed:', msg)
      showAsrSubtitle('ASR 启动失败', { autoHideMs: 4000 })
      stopAsr()
    })
    return () => stopAsr()
  }, [asrEnabled, asrMicDeviceId, asrMode, asrWsUrl, showAsrSubtitle, startAsr, stopAsr])

  const asrConfigKey = useMemo(() => {
    const asr = settings?.asr
    if (!asr) return ''
    const payload = {
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
    }
    return JSON.stringify(payload)
  }, [settings?.asr])

  useEffect(() => {
    if (!asrEnabled) return
    if (!asrClientRef.current) return
    sendAsrConfig()
  }, [asrConfigKey, asrEnabled, sendAsrConfig])

  useEffect(() => {
    return () => {
      stopAsr()
      clearAsrSubtitleTimer()
    }
  }, [clearAsrSubtitleTimer, stopAsr])

  const applyBubblePreviewPayload = useCallback(
    (payload: { text?: string; clear?: boolean; placeholder?: boolean; autoHideDelay?: number; pinPrevious?: boolean }) => {
      const s = settingsRef.current
      if (!s) return
      const showBubble = s.bubble?.showOnChat ?? false
      const nowTs = Date.now()
      const debugPreview = (phase: string, data?: Record<string, unknown>) => {
        if (!api) return
        if (nowTs - bubblePreviewDebugAtRef.current < 180) return
        bubblePreviewDebugAtRef.current = nowTs
        try {
          api.appendDebugLog('pet:bubble.preview', { phase, ...(data ?? {}) })
        } catch {
          /* ignore */
        }
      }
      const commitBubblePayload = (next: BubbleUiPayload | null) => {
        try {
          flushSync(() => setBubblePayload(next))
        } catch {
          setBubblePayload(next)
        }
      }
      const commitPinnedBubblePayload = (next: (BubbleUiPayload & { id: number }) | null) => {
        try {
          flushSync(() => setBubblePinnedPayload(next))
        } catch {
          setBubblePinnedPayload(next)
        }
      }

      if (payload?.clear) {
        if (bubblePreviewActiveRef.current && showBubble) {
          commitBubblePayload(null)
        }
        commitPinnedBubblePayload(null)
        bubblePreviewActiveRef.current = false
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = ''
        debugPreview('clear', { showBubble })
        return
      }

      const rawText = typeof payload?.text === 'string' ? payload.text : ''
      const placeholder = payload?.placeholder === true
      const pinPrevious = payload?.pinPrevious === true
      const autoHideDelay =
        typeof payload?.autoHideDelay === 'number' && Number.isFinite(payload.autoHideDelay) ? payload.autoHideDelay : undefined

      if (pinPrevious && !bubblePreviewActiveRef.current) {
        const current = bubblePayloadRef.current
        const currentText = String(current?.text ?? '').trim()
        if (current && currentText) {
          const nextId = bubblePinnedSeqRef.current + 1
          bubblePinnedSeqRef.current = nextId
          const pinDelay = Math.max(2500, Math.min(15000, Math.floor(s.bubble?.autoHideDelay ?? 5000)))
          commitPinnedBubblePayload({
            id: nextId,
            text: current.text,
            startAt: Date.now(),
            mode: 'append',
            autoHideDelay: pinDelay,
          })
        }
      }

      if (placeholder) {
        bubblePreviewActiveRef.current = true
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = rawText.trim() || '思考中…'
        if (!showBubble) return
        commitBubblePayload({
          text: bubblePreviewTextRef.current,
          startAt: Date.now(),
          mode: 'typing',
          autoHideDelay: typeof autoHideDelay === 'number' ? autoHideDelay : 0,
          animateAppend: false,
          resetAppendFromEmpty: false,
        })
        debugPreview('placeholder', { len: bubblePreviewTextRef.current.length, text: bubblePreviewTextRef.current.slice(0, 32) })
        return
      }

      const firstContentAfterPlaceholder =
        bubblePreviewActiveRef.current && bubblePreviewTextRef.current.trim() === '思考中…' && rawText.trim() !== ''
      if (!rawText.trim()) return
      let startAt = bubblePreviewStartAtRef.current
      if (startAt == null) {
        startAt = Date.now()
        bubblePreviewStartAtRef.current = startAt
      }
      bubblePreviewActiveRef.current = true
      bubblePreviewTextRef.current = rawText
      if (!showBubble) return
      commitBubblePayload({
        text: rawText,
        startAt,
        mode: 'append',
        animateAppend: true,
        resetAppendFromEmpty: firstContentAfterPlaceholder,
        ...(typeof autoHideDelay === 'number' ? { autoHideDelay } : {}),
      })
      debugPreview('text', { len: rawText.length, head: rawText.slice(0, 32), tail: rawText.slice(-24) })
    },
    [api],
  )

  // Listen for bubble messages from chat window
  useEffect(() => {
    if (!api) return
    return api.onBubblePreview((payload) => applyBubblePreviewPayload(payload ?? {}))
  }, [api, applyBubblePreviewPayload])

  useEffect(() => {
    if (!api) return
    return api.onBubbleMessage((message) => {
      const rawMessage = String(message ?? '')
      if (rawMessage.startsWith(BUBBLE_PREVIEW_FALLBACK_PREFIX)) {
        try {
          const payload = JSON.parse(rawMessage.slice(BUBBLE_PREVIEW_FALLBACK_PREFIX.length)) as {
            text?: string
            clear?: boolean
            placeholder?: boolean
            autoHideDelay?: number
            pinPrevious?: boolean
          }
          applyBubblePreviewPayload(payload ?? {})
          return
        } catch {
          // 兼容前缀解析失败时按普通消息继续处理
        }
      }

      const s = settingsRef.current
      if (!s) return

      const showBubble = s.bubble?.showOnChat ?? false
      const bubbleDelay = s.bubble?.autoHideDelay ?? 5000
      const normalizedMessage = String(message ?? '').trim()
      const canAdoptPreview =
        normalizedMessage.length > 0 &&
        bubblePreviewActiveRef.current &&
        bubblePreviewTextRef.current.trim() === normalizedMessage
      const previewStartAt = bubblePreviewStartAtRef.current
      const showBubbleTypingOrAdopt = (text: string, startNow: boolean) => {
        if (!showBubble) return
        if (canAdoptPreview) {
          const adoptedStart = previewStartAt ?? Date.now()
          bubblePreviewStartAtRef.current = adoptedStart
          setBubblePayload({ text, startAt: adoptedStart, mode: 'append', autoHideDelay: bubbleDelay })
          return
        }
        setBubblePayload({ text, startAt: startNow ? Date.now() : null, mode: 'typing' })
      }
      const finishPreviewSession = () => {
        bubblePreviewActiveRef.current = false
        bubblePreviewStartAtRef.current = null
        bubblePreviewTextRef.current = ''
      }
      const tts = s.tts ? { ...s.tts, segmented: false } : s.tts
      const useQueue = Boolean(tts?.enabled) && !(s.tts?.segmented ?? false)

      const startTypingNow = (text: string) => {
        showBubbleTypingOrAdopt(text, true)
      }

      if (tts?.enabled) {
        if (useQueue) {
          bubbleTtsQueueRef.current.push(message)
          if (bubbleTtsQueueRef.current.length > 20) {
            bubbleTtsQueueRef.current = bubbleTtsQueueRef.current.slice(-20)
          }

          if (bubbleTtsRunningRef.current) return
          bubbleTtsRunningRef.current = true

          void (async () => {
            try {
              while (bubbleTtsQueueRef.current.length > 0) {
                const next = bubbleTtsQueueRef.current.shift()
                const text = typeof next === 'string' ? next : ''
                if (!text.trim()) continue
                const speechText = resolveTtsPlaybackText(text, tts)
                if (!speechText) {
                  startTypingNow(text)
                  setMouthOpen(0)
                  continue
                }

                showBubbleTypingOrAdopt(text, false)
                if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
                const player = ttsPlayerRef.current
                if (!player) continue

                await new Promise<void>((resolve) => {
                  void player
                    .speak(speechText, tts, {
                      onFirstPlay: () => {
                        showBubbleTypingOrAdopt(text, true)
                      },
                      onEnded: () => {
                        setMouthOpen(0)
                        resolve()
                      },
                    })
                    .catch(() => {
                      // TTS 失败时也要能正常显示气泡
                      startTypingNow(text)
                      resolve()
                    })
                })
              }
            } finally {
              finishPreviewSession()
              bubbleTtsRunningRef.current = false
            }
          })()
          return
        }

        const speechText = resolveTtsPlaybackText(message, tts)
        if (!speechText) {
          finishPreviewSession()
          startTypingNow(message)
          setMouthOpen(0)
          return
        }

        showBubbleTypingOrAdopt(message, false)
        if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()

        void ttsPlayerRef.current
          .speak(speechText, tts, {
            onFirstPlay: () => {
              showBubbleTypingOrAdopt(message, true)
            },
            onEnded: () => {
              setMouthOpen(0)
              finishPreviewSession()
            },
          })
          .catch(() => {
            // TTS 失败时也要能正常显示气泡
            startTypingNow(message)
            finishPreviewSession()
          })
        return
      }

      finishPreviewSession()
      startTypingNow(message)
    })
  }, [api, applyBubblePreviewPayload])

  // Listen for segmented TTS utterances from chat window
  useEffect(() => {
    if (!api) return

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

    const wakeQueue = () => {
      if (!ttsQueueWakeRef.current) return
      const w = ttsQueueWakeRef.current
      ttsQueueWakeRef.current = null
      w()
    }

    const runQueue = async () => {
      if (ttsQueueRunningRef.current) return
      ttsQueueRunningRef.current = true
      try {
        while (ttsQueueRef.current) {
          const current = ttsQueueRef.current
          const s = settingsRef.current
          if (!current || !s?.tts?.enabled || !s.tts.segmented) return

          if (current.playIndex >= current.segments.length) {
            if (current.finalized) {
              const utteranceId = current.utteranceId
              if (ttsActiveUtteranceRef.current === utteranceId) ttsActiveUtteranceRef.current = null
              ttsQueueRef.current = null
              setMouthOpen(0)
              setBubblePayload(null)
              api.reportTtsUtteranceEnded({ utteranceId })
              wakeQueue()
              return
            }

            await new Promise<void>((resolve) => {
              ttsQueueWakeRef.current = resolve
            })
            continue
          }

          const utteranceId = current.utteranceId
          const segmentIndex = current.playIndex
          current.playIndex = segmentIndex + 1
          const raw = String(current.segments[segmentIndex] ?? '')
          const segText = raw.trim()
          if (!segText) continue

          if (!ttsPlayerRef.current) ttsPlayerRef.current = new TtsPlayer()
          const player = ttsPlayerRef.current
          if (!player) continue

          ttsActiveUtteranceRef.current = utteranceId

          const showBubble = s.bubble?.showOnChat ?? false
          const bubbleDelay = s.bubble?.autoHideDelay ?? 5000
          const ttsSettings = { ...s.tts, streaming: true, segmented: false }
          const pauseMs = Math.max(0, Math.min(60000, Math.floor(s.tts.pauseMs ?? 0)))
          const speechText = resolveTtsPlaybackText(segText, s.tts)

          if (showBubble) setBubblePayload({ text: segText, startAt: null, mode: 'append', autoHideDelay: bubbleDelay })

          let ended = false
          let voiceReported = false

          const reportVoiceStart = () => {
            if (voiceReported) return
            voiceReported = true
            const spoken = trimTrailingCommaForSegment(segText)
            try {
              api.reportTtsSegmentStarted({ utteranceId, segmentIndex, text: spoken })
            } catch {
              /* ignore */
            }
            if (showBubble) {
              setBubblePayload({ text: spoken, startAt: Date.now(), mode: 'append', autoHideDelay: bubbleDelay })
            }
          }

          if (!speechText) {
            reportVoiceStart()
            setMouthOpen(0)
            if (pauseMs > 0) await sleep(Math.min(pauseMs, 200))
            continue
          }

          await new Promise<void>((resolve) => {
            void player
              .speak(speechText, ttsSettings, {
                onFirstPlay: () => {
                  const startedAt = Date.now()
                  const threshold = 0.006
                  const tick = () => {
                    if (ended) return
                    if (ttsActiveUtteranceRef.current !== utteranceId) return
                    const level = player.getLevel()
                    if (level >= threshold || Date.now() - startedAt > 1200) {
                      reportVoiceStart()
                      return
                    }
                    window.requestAnimationFrame(tick)
                  }
                  window.requestAnimationFrame(tick)
                },
                onEnded: () => {
                  ended = true
                  resolve()
                },
              })
              .catch((err) => {
                ended = true
                const msg = err instanceof Error ? err.message : String(err)
                try {
                  api.reportTtsUtteranceFailed({ utteranceId, error: msg })
                } catch {
                  /* ignore */
                }
                resolve()
              })
          })

          reportVoiceStart()
          if (pauseMs > 0) await sleep(pauseMs)
        }
      } finally {
        ttsQueueRunningRef.current = false
      }
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
        ttsActiveUtteranceRef.current = null
        ttsPlayerRef.current?.stop()
        setMouthOpen(0)
        ttsQueueRef.current = {
          utteranceId: payload.utteranceId,
          segments: [],
          finalized: false,
          playIndex: 0,
        }
        setBubblePayload(null)
        wakeQueue()
      }

      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== payload.utteranceId) return

      if (payload.segments?.length) current.segments.push(...payload.segments)
      wakeQueue()
      void runQueue()
    })

    const unsubFinalize = api.onTtsFinalize((utteranceId) => {
      const current = ttsQueueRef.current
      if (!current || current.utteranceId !== utteranceId) return
      current.finalized = true
      wakeQueue()
      void runQueue()
    })

    return () => {
      unsubEnqueue()
      unsubFinalize()
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onTtsStopAll(() => {
      const utteranceId = ttsActiveUtteranceRef.current ?? ttsQueueRef.current?.utteranceId ?? null
      if (utteranceId) {
        api.reportTtsUtteranceEnded({ utteranceId })
      }

      bubbleTtsQueueRef.current = []
      ttsActiveUtteranceRef.current = null
      ttsQueueRef.current = null
      ttsQueueRunningRef.current = false
      ttsPlayerRef.current?.stop()
      if (ttsQueueWakeRef.current) {
        const w = ttsQueueWakeRef.current
        ttsQueueWakeRef.current = null
        w()
      }
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
  }, [api])

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dMouseTrackingEnabled = settings?.live2dMouseTrackingEnabled !== false
  const live2dIdleSwayEnabled = settings?.live2dIdleSwayEnabled !== false
  const bubbleSettings = settings?.bubble
  const taskPanelX = settings?.taskPanel?.positionX ?? 50
  const taskPanelY = settings?.taskPanel?.positionY ?? 78
  // 仅展示“进行中”任务：failed/done/canceled 不应长期挂在面板里（否则用户会误以为还在跑且无法终止）
  const visibleTasks = tasks.filter((t) => {
    const active = t.status === 'pending' || t.status === 'running' || t.status === 'paused'
    if (!active) return false

    // chat 来源的 agent.run：在聊天里看到第一张工具卡后再让面板出现，避免“任务面板抢跑”造成割裂观感。
    const isChatAgentRun = t.queue === 'chat' && typeof t.why === 'string' && t.why.includes('agent.run')
    if (isChatAgentRun) {
      // 注意过滤掉 agent.run 壳 run 本身，否则纯聊天（未调用任何真实工具）时面板也会立刻弹出
      const runs = filterVisibleToolRuns(Array.isArray(t.toolRuns) ? t.toolRuns : [])
      if (runs.length === 0) return false
    }

    return true
  })

  const pixelHitRef = useRef(false)
  const domHitRef = useRef(false)
  const modelHoverSentRef = useRef(false)

  const syncModelHover = useCallback(() => {
    if (!api) return
    const next = pixelHitRef.current || domHitRef.current
    if (next === modelHoverSentRef.current) return
    modelHoverSentRef.current = next
    api.setPetModelHover(next)
  }, [api])

  const handleLive2dPixelHit = useCallback(
    (hit: boolean) => {
      pixelHitRef.current = hit
      syncModelHover()
    },
    [syncModelHover],
  )

  // 点击穿透模式下窗口仍会收到转发的 mousemove：用 elementFromPoint 判断光标
  // 是否落在任务面板/上下文悬浮球/气泡等 DOM 浮层上，与 Live2D 画布像素命中合并上报，
  // 由主进程据此切换 ignoreMouseEvents。
  useEffect(() => {
    if (!api) return
    const INTERACTIVE_SELECTOR = '.ndp-task-panel, .ndp-context-orb, .speech-bubble'

    const checkPoint = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      const hit = Boolean(el && el.closest(INTERACTIVE_SELECTOR))
      if (hit === domHitRef.current) return
      domHitRef.current = hit
      syncModelHover()
    }
    const onMouseMove = (e: MouseEvent) => checkPoint(e.clientX, e.clientY)
    const onPointerGone = () => {
      if (!domHitRef.current) return
      domHitRef.current = false
      syncModelHover()
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })
    document.addEventListener('mouseleave', onPointerGone)
    window.addEventListener('blur', onPointerGone)
    // 穿透模式下 mousemove 不可靠，主进程探针泵推送的光标坐标同样参与 DOM 浮层命中
    const unsubProbe = api.onPetCursorProbe((p) => {
      if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return
      checkPoint(p.x, p.y)
    })
    return () => {
      unsubProbe()
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onPointerGone)
      window.removeEventListener('blur', onPointerGone)
      pixelHitRef.current = false
      domHitRef.current = false
      if (modelHoverSentRef.current) {
        modelHoverSentRef.current = false
        api.setPetModelHover(false)
      }
    }
  }, [api, syncModelHover])

  // Get model URL directly from settings
  const modelJsonUrl = settings?.live2dModelFile ?? '/live2d/Haru/Haru.model3.json'

  // 解析当前 Live2D 模型的可用表情/动作名，用于工具调用时做更通用的触发（尽量不硬编码具体名字）
  useEffect(() => {
    let cancelled = false
    let watermarkTimer: number | null = null
    parseModelMetadata(modelJsonUrl)
      .then((metadata) => {
        if (cancelled) return
        const expressions = metadata.expressions?.map((e) => e.name).filter(Boolean) ?? []
        const motions = metadata.motionGroups?.map((g) => g.name).filter(Boolean) ?? []
        toolAnimRef.current = { motionGroups: motions, expressions }

        // 仅当当前模型声明了“关闭水印”表达式时，启动阶段自动触发几次，避免模型初始化时丢触发。
        const watermarkExpression = expressions.find((name) => name.trim() === '关闭水印') ?? null
        if (watermarkExpression && api) {
          let attempts = 0
          const triggerWatermarkExpression = () => {
            if (cancelled) return
            attempts += 1
            api.triggerExpression(watermarkExpression)
            if (attempts < 6) {
              watermarkTimer = window.setTimeout(triggerWatermarkExpression, 260)
            }
          }
          triggerWatermarkExpression()
        }
      })
      .catch(() => {
        if (cancelled) return
        toolAnimRef.current = { motionGroups: [], expressions: [] }
      })
    return () => {
      cancelled = true
      if (watermarkTimer) {
        window.clearTimeout(watermarkTimer)
        watermarkTimer = null
      }
    }
  }, [api, modelJsonUrl])

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

  const cancelQueuedDragMove = useCallback(() => {
    if (!dragMoveRafRef.current) return
    window.cancelAnimationFrame(dragMoveRafRef.current)
    dragMoveRafRef.current = 0
  }, [])

  const flushQueuedDragMove = useCallback(
    (point?: { x: number; y: number }) => {
      if (point) pendingDragPointRef.current = point
      const next = pendingDragPointRef.current
      if (!next) return
      pendingDragPointRef.current = null
      api?.dragMove(next)
    },
    [api],
  )

  const scheduleDragMove = useCallback(
    (point: { x: number; y: number }) => {
      pendingDragPointRef.current = point
      if (dragMoveRafRef.current) return
      dragMoveRafRef.current = window.requestAnimationFrame(() => {
        dragMoveRafRef.current = 0
        flushQueuedDragMove()
      })
    },
    [flushQueuedDragMove],
  )

  const stopWindowDrag = useCallback(
    (point?: { x: number; y: number }) => {
      if (!isDragging.current) return
      cancelQueuedDragMove()
      flushQueuedDragMove(point)
      pendingDragPointRef.current = null
      isDragging.current = false
      dragPointerId.current = null
      setWindowDragging(false)
      api?.stopDrag(point)
    },
    [api, cancelQueuedDragMove, flushQueuedDragMove],
  )

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('[data-no-window-drag="true"]')) return
    if (e.button !== 0) return
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (!isOverModel.current) return

    isDragging.current = true
    dragPointerId.current = e.pointerId
    clickStartTime.current = Date.now()

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    pendingDragPointRef.current = null
    cancelQueuedDragMove()
    setWindowDragging(true)
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    api?.startDrag(point)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current) return

    if (!isDragging.current) {
      isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
      return
    }

    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    scheduleDragMove(point)
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    if (e.button !== 0) return
    if (!isDragging.current) return

    const point = { x: e.screenX, y: e.screenY }
    lastDragPoint.current = point
    stopWindowDrag(point)

    const clickDuration = Date.now() - clickStartTime.current
    if (clickDuration < 200 && bubbleSettings?.showOnClick) {
      const phrases = bubbleSettings?.clickPhrases?.length > 0 ? bubbleSettings.clickPhrases : defaultPhrases
      if (phrases.length > 0) {
        const phrase = phrases[Math.floor(Math.random() * phrases.length)]
        setBubblePayload({ text: phrase, startAt: Date.now(), mode: 'typing' })
      }
    }
  }

  const handlePointerCancel = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    const point = { x: e.screenX, y: e.screenY }
    stopWindowDrag(point)
  }

  const handleLostPointerCapture = (e: React.PointerEvent) => {
    if (dragPointerId.current !== null && e.pointerId !== dragPointerId.current) return
    const point = { x: e.screenX, y: e.screenY }
    stopWindowDrag(point)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    isOverModel.current = isPointOverLive2D(e.clientX, e.clientY)
    if (isOverModel.current) {
      e.preventDefault()
      api?.showContextMenu()
    }
  }

  const handleBubbleClose = useCallback(() => {
    setBubblePayload(null)
    bubblePreviewActiveRef.current = false
    bubblePreviewStartAtRef.current = null
    bubblePreviewTextRef.current = ''
  }, [])

  const handlePinnedBubbleClose = useCallback(() => {
    setBubblePinnedPayload(null)
  }, [])

  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!isDragging.current) return
      stopWindowDrag({ x: e.screenX, y: e.screenY })
    }
    const handleWindowBlur = () => {
      if (!isDragging.current) return
      stopWindowDrag(undefined)
    }
    const handleVisibilityChange = () => {
      if (!document.hidden) return
      if (!isDragging.current) return
      stopWindowDrag(undefined)
    }

    window.addEventListener('mouseup', handleGlobalMouseUp, true)
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp, true)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      cancelQueuedDragMove()
      pendingDragPointRef.current = null
    }
  }, [cancelQueuedDragMove, stopWindowDrag])

  return (
    <div
      ref={containerRef}
      className="ndp-pet-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
    >
      <Live2DView
        modelJsonUrl={modelJsonUrl}
        scale={petScale}
        opacity={petOpacity}
        mouthOpen={mouthOpen}
        windowDragging={windowDragging}
        mouseTrackingEnabled={live2dMouseTrackingEnabled}
        idleSwayEnabled={live2dIdleSwayEnabled}
        onPixelHitChange={handleLive2dPixelHit}
      />
      <ContextUsageOrb
        enabled={bubbleSettings?.contextOrbEnabled ?? false}
        usage={contextUsage}
        position={{ x: bubbleSettings?.contextOrbX ?? 12, y: bubbleSettings?.contextOrbY ?? 16 }}
        onPositionChange={(next) => api?.setBubbleSettings({ contextOrbX: next.x, contextOrbY: next.y })}
        interactionDisabled={windowDragging}
      />
      {asrShowSubtitle && asrSubtitle.trim() && (
        <div className={`ndp-asr-subtitle${asrRecording ? ' ndp-asr-subtitle-recording' : ''}`}>{asrSubtitle}</div>
      )}
      {bubblePinnedPayload && (
        <SpeechBubble
          key={`pinned-${bubblePinnedPayload.id}`}
          text={bubblePinnedPayload.text}
          startAt={bubblePinnedPayload.startAt}
          mode={bubblePinnedPayload.mode}
          animateAppend={bubblePinnedPayload.animateAppend}
          resetAppendFromEmpty={bubblePinnedPayload.resetAppendFromEmpty}
          style={bubbleSettings?.style ?? 'cute'}
          positionX={bubbleSettings?.positionX ?? 75}
          positionY={(() => {
            const baseY = bubbleSettings?.positionY ?? 10
            return baseY >= 18 ? baseY - 12 : Math.min(100, baseY + 12)
          })()}
          tailDirection={bubbleSettings?.tailDirection ?? 'down'}
          autoHideDelay={bubblePinnedPayload.autoHideDelay ?? (bubbleSettings?.autoHideDelay ?? 5000)}
          onClose={handlePinnedBubbleClose}
        />
      )}
      {bubblePayload && (
        <SpeechBubble
          key={`${bubblePayload.startAt ?? 'pending'}-${bubblePayload.mode}`}
          text={bubblePayload.text}
          startAt={bubblePayload.startAt}
          mode={bubblePayload.mode}
          animateAppend={bubblePayload.animateAppend}
          resetAppendFromEmpty={bubblePayload.resetAppendFromEmpty}
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
          ref={taskPanelRef}
          className="ndp-task-panel"
          data-no-window-drag="true"
          style={{ left: `${taskPanelX}%`, top: `${taskPanelY}%`, transform: 'translate(-50%, 0)' }}
          onMouseEnter={() => api?.setPetOverlayHover(true)}
          onMouseLeave={() => api?.setPetOverlayHover(false)}
          onPointerEnter={() => api?.setPetOverlayHover(true)}
          onPointerLeave={() => api?.setPetOverlayHover(false)}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
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
            const outputPreview = ((lastStep?.output ?? '') || (currentStep?.output ?? '')).trim()
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
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.pauseTask(task.id).catch((err) => console.error(err))}
                    >
                      暂停
                    </button>
                  )}
                  {task.status === 'paused' && (
                    <button
                      className="ndp-task-btn"
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void api?.resumeTask(task.id).catch((err) => console.error(err))}
                    >
                      继续
                    </button>
                  )}
                  <button
                    className="ndp-task-btn ndp-task-btn-danger"
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (!api) return
                      // 兜底：极少数情况下 terminal task 仍被渲染到面板里，此时“终止”改为清理
                      if (task.status === 'pending' || task.status === 'running' || task.status === 'paused') {
                        void api.cancelTask(task.id).catch((err) => console.error(err))
                      } else {
                        void api.dismissTask(task.id).catch((err) => console.error(err))
                      }
                    }}
                  >
                    {task.status === 'pending' || task.status === 'running' || task.status === 'paused' ? '终止' : '清除'}
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
