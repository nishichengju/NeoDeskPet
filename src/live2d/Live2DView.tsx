import { useEffect, useMemo, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'
import { defaultModelJsonUrl } from './live2dModels'
import {
  createLive2dParamAccessor,
  createLive2dParamScriptEngine,
  type Live2dCapabilities,
  type Live2dParamScriptEngine,
} from './live2dParamTools'
import { getApi } from '../neoDeskPetApi'

type Props = {
  windowDragging?: boolean
  modelJsonUrl?: string
  scale?: number
  opacity?: number
  mouthOpen?: number
  mouseTrackingEnabled?: boolean
  idleSwayEnabled?: boolean
}

export function Live2DView(props: Props) {
  const {
    modelJsonUrl,
    scale = 1.0,
    opacity = 1.0,
    mouthOpen = 0,
    windowDragging = false,
    mouseTrackingEnabled = true,
    idleSwayEnabled = true,
  } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<Live2DModel | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)

  const mouthOpenRef = useRef(0)
  const windowDraggingRef = useRef(false)
  const mouseTrackingEnabledRef = useRef(true)
  const idleSwayEnabledRef = useRef(true)

  const paramAccessorRef = useRef<ReturnType<typeof createLive2dParamAccessor> | null>(null)
  const scriptEngineRef = useRef<Live2dParamScriptEngine | null>(null)
  const pendingParamScriptsRef = useRef<unknown[]>([])

  const mouseTargetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const mouseCurrentRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const mouseResettingRef = useRef(false)

  const lastLayoutRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 0 })
  const syncLayoutRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    mouthOpenRef.current = Math.max(0, Math.min(1.25, mouthOpen))
  }, [mouthOpen])

  useEffect(() => {
    windowDraggingRef.current = windowDragging
  }, [windowDragging])

  useEffect(() => {
    mouseTrackingEnabledRef.current = mouseTrackingEnabled !== false
    if (!mouseTrackingEnabledRef.current) {
      mouseTargetRef.current = { x: 0, y: 0 }
      mouseResettingRef.current = true

      const accessor = paramAccessorRef.current
      if (accessor) {
        const setParam = accessor.set
        setParam('ParamAngleX', 0)
        setParam('ParamAngleY', 0)
        setParam('ParamAngleZ', 0)
        setParam('ParamEyeBallX', 0)
        setParam('ParamEyeBallY', 0)
        setParam('ParamBodyAngleX', 0)
        setParam('ParamBodyAngleY', 0)
      }
    } else {
      mouseResettingRef.current = false
    }
  }, [mouseTrackingEnabled])

  useEffect(() => {
    idleSwayEnabledRef.current = idleSwayEnabled !== false
  }, [idleSwayEnabled])

  const selectedModelUrl = useMemo(() => modelJsonUrl ?? defaultModelJsonUrl, [modelJsonUrl])

  useEffect(() => {
    if (!containerRef.current) return

    setModelLoaded(false)
    ;(window as unknown as { PIXI?: unknown }).PIXI = PIXI

    const initW = Math.max(1, containerRef.current.clientWidth)
    const initH = Math.max(1, containerRef.current.clientHeight)

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      sharedTicker: true,
      width: initW,
      height: initH,
    })

    try {
      const ticker = app.ticker
      if (ticker && (ticker.maxFPS === 0 || ticker.maxFPS > 30)) {
        ticker.maxFPS = 30
      }
    } catch {
      // ignore
    }

    appRef.current = app
    containerRef.current.appendChild(app.view as unknown as Node)

    let destroyed = false

    const load = async () => {
      const live2d = await Live2DModel.from(selectedModelUrl, {
        autoInteract: false,
        autoUpdate: true,
      })

      if (destroyed || !live2d) return

      modelRef.current = live2d
      app.stage.addChild(live2d)
      live2d.anchor.set(0.5, 0.5)

      try {
        const internal = live2d.internalModel as unknown as {
          originalWidth?: number
          originalHeight?: number
          width?: number
          height?: number
        }

        const bounds = live2d.getLocalBounds()
        const bW = typeof bounds?.width === 'number' && Number.isFinite(bounds.width) ? bounds.width : 0
        const bH = typeof bounds?.height === 'number' && Number.isFinite(bounds.height) ? bounds.height : 0

        const iW =
          (typeof internal.width === 'number' && internal.width > 0 ? internal.width : 0) ||
          (typeof internal.originalWidth === 'number' && internal.originalWidth > 0 ? internal.originalWidth : 0)
        const iH =
          (typeof internal.height === 'number' && internal.height > 0 ? internal.height : 0) ||
          (typeof internal.originalHeight === 'number' && internal.originalHeight > 0 ? internal.originalHeight : 0)

        naturalSizeRef.current = {
          width: Math.max(1, bW || iW || live2d.width || 1),
          height: Math.max(1, bH || iH || live2d.height || 1),
        }
      } catch {
        naturalSizeRef.current = {
          width: Math.max(1, live2d.width || 1),
          height: Math.max(1, live2d.height || 1),
        }
      }

      const accessor = createLive2dParamAccessor(live2d)
      paramAccessorRef.current = accessor
      const engine = createLive2dParamScriptEngine(accessor)
      scriptEngineRef.current = engine

      if (pendingParamScriptsRef.current.length > 0) {
        const pending = pendingParamScriptsRef.current.splice(0, 20)
        for (const item of pending) {
          engine.enqueue(item)
        }
      }

      const api = getApi()
      if (api) {
        const reportCaps = (attempt: number) => {
          if (destroyed) return
          const caps: Live2dCapabilities = {
            modelJsonUrl: selectedModelUrl,
            updatedAt: Date.now(),
            parameters: accessor.listParameters(),
          }
          api.reportLive2dCapabilities(caps)
          if (caps.parameters.length === 0 && attempt < 12) {
            setTimeout(() => reportCaps(attempt + 1), 250)
          }
        }
        reportCaps(0)
      }

      const setParam = accessor.set
      try {
        mouseTargetRef.current = { x: 0, y: 0 }
        mouseCurrentRef.current = { x: 0, y: 0 }
        mouseResettingRef.current = false
        setParam('ParamAngleX', 0)
        setParam('ParamAngleY', 0)
        setParam('ParamAngleZ', 0)
        setParam('ParamEyeBallX', 0)
        setParam('ParamEyeBallY', 0)
      } catch {
        // ignore
      }

      let physicsTime = 0

      try {
        const internal = live2d.internalModel as unknown as {
          update?: (dtMs: number, elapsedMs: number) => void
        }

        const originalUpdate = typeof internal?.update === 'function' ? internal.update.bind(internal) : null
        if (originalUpdate) {
          internal.update = (dtMs: number, elapsedMs: number) => {
            const safeDtMs = typeof dtMs === 'number' && Number.isFinite(dtMs) ? dtMs : 0
            const clampedDtMs = Math.max(0, Math.min(safeDtMs, 1000 / 20))
            originalUpdate(clampedDtMs, elapsedMs)

            const dtSec = clampedDtMs / 1000
            physicsTime += dtSec

            scriptEngineRef.current?.tick(clampedDtMs)

            const allowControl = !windowDraggingRef.current
            const trackingEnabled = mouseTrackingEnabledRef.current
            const resetting = !trackingEnabled && mouseResettingRef.current

            if (allowControl) {
              const target = mouseTargetRef.current
              const cur = mouseCurrentRef.current
              const tx = trackingEnabled ? target.x : 0
              const ty = trackingEnabled ? target.y : 0
              const k = 1 - Math.pow(0.001, Math.max(0, dtSec))

              cur.x = cur.x + (tx - cur.x) * k
              cur.y = cur.y + (ty - cur.y) * k

              setParam('ParamAngleX', cur.x * 30)
              setParam('ParamAngleY', -cur.y * 30)
              setParam('ParamAngleZ', cur.x * -5)
              setParam('ParamEyeBallX', cur.x)
              setParam('ParamEyeBallY', -cur.y)

              if (resetting && Math.abs(cur.x) < 0.01 && Math.abs(cur.y) < 0.01) {
                cur.x = 0
                cur.y = 0
                mouseResettingRef.current = false
                setParam('ParamAngleX', 0)
                setParam('ParamAngleY', 0)
                setParam('ParamAngleZ', 0)
                setParam('ParamEyeBallX', 0)
                setParam('ParamEyeBallY', 0)
              }
            }

            setParam('ParamBreath', (Math.sin(physicsTime * 1.5) + 1) * 0.5)
            if (idleSwayEnabledRef.current && !windowDraggingRef.current) {
              const swayAngle =
                Math.sin(physicsTime * 1.5) * 5 + Math.sin(physicsTime * 0.7) * 3 + Math.sin(physicsTime * 2.3) * 1.5
              setParam('ParamBodyAngleZ', swayAngle)
              setParam('ParamBodyAngleX', Math.sin(physicsTime * 0.5) * 2)
              setParam('ParamBodyAngleY', Math.sin(physicsTime * 0.8) * 1.5)
            }
            setParam('ParamMouthOpenY', mouthOpenRef.current)
          }
        }
      } catch {
        // ignore
      }

      setModelLoaded(true)
    }

    load().catch((err) => {
      console.error('[Live2D] load failed', err)
    })

    return () => {
      destroyed = true
      modelRef.current = null
      paramAccessorRef.current = null
      scriptEngineRef.current = null
      appRef.current = null
      naturalSizeRef.current = null

      try {
        app.destroy(true, { children: true })
      } catch {
        // ignore
      }
    }
  }, [selectedModelUrl])

  useEffect(() => {
    const api = getApi() as unknown as
      | {
          onLive2dMouseTarget?: (listener: (payload: { x: number; y: number }) => void) => () => void
        }
      | null
    if (!api || typeof api.onLive2dMouseTarget !== 'function') return

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

    return api.onLive2dMouseTarget((payload) => {
      if (!mouseTrackingEnabledRef.current) return
      if (windowDraggingRef.current) return
      const x = typeof payload?.x === 'number' && Number.isFinite(payload.x) ? payload.x : 0
      const y = typeof payload?.y === 'number' && Number.isFinite(payload.y) ? payload.y : 0
      mouseTargetRef.current = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }
    })
  }, [])

  useEffect(() => {
    const api = getApi()
    if (!api) return

    const unsubExpression = api.onLive2dExpression((expressionName) => {
      const model = modelRef.current
      if (!model) return
      try {
        model.expression(expressionName)
      } catch (err) {
        console.warn('[Live2D] Failed to trigger expression:', err)
      }
    })

    const unsubMotion = api.onLive2dMotion((motionGroup, index) => {
      const model = modelRef.current
      if (!model) return
      try {
        model.motion(motionGroup, index)
      } catch (err) {
        console.warn('[Live2D] Failed to trigger motion:', err)
      }
    })

    const unsubParamScript = api.onLive2dParamScript((payload) => {
      const engine = scriptEngineRef.current
      if (!engine) {
        pendingParamScriptsRef.current.push(payload)
        if (pendingParamScriptsRef.current.length > 20) {
          pendingParamScriptsRef.current.splice(0, pendingParamScriptsRef.current.length - 20)
        }
        return
      }
      const res = engine.enqueue(payload)
      if (!res.ok) {
        console.warn('[Live2D] Param script rejected:', res.error ?? 'unknown')
      }
    })

    return () => {
      unsubExpression()
      unsubMotion()
      unsubParamScript()
    }
  }, [modelLoaded])

  useEffect(() => {
    if (!modelLoaded) return

    const container = containerRef.current
    const app = appRef.current
    if (!container || !app) return

    lastLayoutRef.current = { w: 0, h: 0, dpr: 0 }

    const syncLayout = () => {
      const containerNode = containerRef.current
      const appNode = appRef.current
      if (!containerNode || !appNode) return

      // 拖动窗口期间冻结布局重算，避免因 DPI/resize 抖动触发模型反复缩放和闪烁。
      if (windowDraggingRef.current) return

      const w = Math.max(1, containerNode.clientWidth)
      const h = Math.max(1, containerNode.clientHeight)
      const dpr = window.devicePixelRatio || 1

      const last = lastLayoutRef.current
      const sizeChanged = w !== last.w || h !== last.h
      const dprChanged = Math.abs(dpr - last.dpr) > 0.001
      if (!sizeChanged && !dprChanged) {
        const model = modelRef.current
        if (model) {
          model.position.set(w / 2, h / 2 + h * 0.06)
        }
        return
      }

      try {
        if (dprChanged) {
          appNode.renderer.resolution = dpr
          const interaction = (appNode.renderer.plugins as unknown as { interaction?: { resolution?: number } }).interaction
          if (interaction && typeof interaction.resolution === 'number') {
            interaction.resolution = dpr
          }
        }

        if (sizeChanged || dprChanged) {
          appNode.renderer.resize(w, h)
        }

        const model = modelRef.current
        const natural = naturalSizeRef.current
        if (model && natural) {
          const padding = 0.92
          const targetW = w * padding
          const targetH = h * padding

          let baseScale = Math.min(targetW / natural.width, targetH / natural.height)
          if (!Number.isFinite(baseScale) || baseScale <= 0 || baseScale > 10) {
            baseScale = 0.15
          }

          const currentScale = typeof model.scale?.x === 'number' ? model.scale.x : Number.NaN
          const denom = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1
          const relDiff = Math.abs(baseScale - denom) / denom
          if (!Number.isFinite(currentScale) || relDiff > 0.003) {
            model.scale.set(baseScale)
          }

          model.position.set(w / 2, h / 2 + h * 0.06)
        } else if (model) {
          model.position.set(w / 2, h / 2 + h * 0.06)
        }

        lastLayoutRef.current = { w, h, dpr }
      } catch {
        // ignore
      }
    }

    syncLayoutRef.current = syncLayout
    syncLayout()

    const handleWindowResize = () => syncLayout()
    window.addEventListener('resize', handleWindowResize)

    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(() => syncLayout())
      ro.observe(container)
    } catch {
      ro = null
    }

    const buildDprPollMs = () => (document.hidden ? 1500 : 700)
    let dprTimer = window.setInterval(() => {
      if (windowDraggingRef.current) return
      syncLayout()
    }, buildDprPollMs())

    const onVisibilityChange = () => {
      window.clearInterval(dprTimer)
      dprTimer = window.setInterval(() => syncLayout(), buildDprPollMs())
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('resize', handleWindowResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (ro) ro.disconnect()
      window.clearInterval(dprTimer)
      syncLayoutRef.current = null
    }
  }, [modelLoaded, scale])

  useEffect(() => {
    if (!modelLoaded) return
    syncLayoutRef.current?.()
  }, [windowDragging, modelLoaded])

  useEffect(() => {
    if (modelRef.current && modelLoaded) {
      modelRef.current.alpha = opacity
    }
  }, [opacity, modelLoaded])

  return <div ref={containerRef} className="ndp-live2d-root" />
}
