import { useEffect, useMemo, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'
import { defaultModelJsonUrl } from './live2dModels'
import { getApi } from '../neoDeskPetApi'

type Props = {
  windowDragging?: boolean // 窗口是否正在被拖动（用于高频同步画布/布局）
  modelJsonUrl?: string
  scale?: number
  opacity?: number
  mouthOpen?: number // 0.0 - 1.0，用于口型模拟
}

type Live2DParamSetter = (id: string, value: number) => void

function createParamSetter(model: Live2DModel): Live2DParamSetter {
  return (id, value) => {
    const internalModel = model.internalModel as unknown as {
      coreModel?: {
        setParameterValueById?: (paramId: string, v: number) => void
        setParamFloat?: (paramId: string, v: number) => void
      }
    }

    const core = internalModel?.coreModel
    if (!core) return

    try {
      if (core.setParameterValueById) {
        core.setParameterValueById(id, value)
        return
      }
      if (core.setParamFloat) {
        const cubism2Name = id
          .replace('Param', 'PARAM_')
          .replace(/([A-Z])/g, '_$1')
          .toUpperCase()
        core.setParamFloat(cubism2Name, value)
      }
    } catch {
      // ignore
    }
  }
}

export function Live2DView(props: Props) {
  const { modelJsonUrl, scale = 1.0, opacity = 1.0, mouthOpen = 0, windowDragging = false } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<Live2DModel | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const mouthOpenRef = useRef(0)
  const windowDraggingRef = useRef(false)
  const lastLayoutRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 0 })
  const syncLayoutRef = useRef<(() => void) | null>(null)
  const dragRafRef = useRef<number>(0)
  const pendingScaleAfterDragRef = useRef(false)

  useEffect(() => {
    mouthOpenRef.current = Math.max(0, Math.min(1.25, mouthOpen))
  }, [mouthOpen])

  useEffect(() => {
    windowDraggingRef.current = windowDragging
  }, [windowDragging])

  const selectedModelUrl = useMemo(() => modelJsonUrl ?? defaultModelJsonUrl, [modelJsonUrl])

  // Initialize PIXI and Live2D
  useEffect(() => {
    if (!containerRef.current) return

    setModelLoaded(false)
    ;(window as unknown as { PIXI?: unknown }).PIXI = PIXI

    // 使用 clientWidth/Height（整数、稳定）避免拖动窗口/跨屏 DPI 变化时出现小数抖动
    const initW = Math.max(1, containerRef.current.clientWidth)
    const initH = Math.max(1, containerRef.current.clientHeight)

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: initW,
      height: initH,
    })

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

      // 记录稳定的“自然尺寸”，用于后续 fit-to-window 的 scale 计算
      // 优先取 localBounds（更接近可见范围），其次 internalModel 原始尺寸，最后退回 live2d.width/height
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

      const setParam = createParamSetter(live2d)
      let physicsTime = 0

      app.ticker.add((delta) => {
        if (!modelRef.current) return
        const dt = delta / 60
        physicsTime += dt

        setParam('ParamBreath', (Math.sin(physicsTime * 1.5) + 1) * 0.5)
        setParam('ParamBodyAngleZ', Math.sin(physicsTime * 1.1) * 6)
        setParam('ParamMouthOpenY', mouthOpenRef.current)
      })

      setModelLoaded(true)
    }

    load().catch((err) => {
      console.error('[Live2D] load failed', err)
    })

    return () => {
      destroyed = true
      modelRef.current = null
      appRef.current = null
      naturalSizeRef.current = null

      try {
        app.destroy(true, { children: true })
      } catch {
        // ignore
      }
    }
  }, [selectedModelUrl])

  // Listen for expression/motion triggers from settings window
  useEffect(() => {
    const api = getApi()
    if (!api) return

    const unsubExpression = api.onLive2dExpression((expressionName) => {
      const model = modelRef.current
      if (!model) return

      console.log('[Live2D] Triggering expression:', expressionName)
      try {
        // pixi-live2d-display expression API
        model.expression(expressionName)
      } catch (err) {
        console.warn('[Live2D] Failed to trigger expression:', err)
      }
    })

    const unsubMotion = api.onLive2dMotion((motionGroup, index) => {
      const model = modelRef.current
      if (!model) return

      console.log('[Live2D] Triggering motion:', motionGroup, index)
      try {
        // pixi-live2d-display motion API
        model.motion(motionGroup, index)
      } catch (err) {
        console.warn('[Live2D] Failed to trigger motion:', err)
      }
    })

    return () => {
      unsubExpression()
      unsubMotion()
    }
  }, [modelLoaded])

  // 同步画布大小/分辨率与模型位置：
  // - Windows/Electron 在拖动窗口、跨显示器（不同缩放比例）时，devicePixelRatio/布局可能变化
  // - 若 PIXI renderer 不同步 resize/resolution，会导致 Live2D 画面与 DOM 覆盖层（气泡/小球）相对位置“漂移”
  useEffect(() => {
    if (!modelLoaded) return

    const container = containerRef.current
    const app = appRef.current
    if (!container || !app) return

    // reset once per attach (avoid resetting on windowDragging toggles)
    lastLayoutRef.current = { w: 0, h: 0, dpr: 0 }

    const syncLayout = () => {
      const container = containerRef.current
      const app = appRef.current
      if (!container || !app) return

      // 使用 clientWidth/Height（整数、稳定）避免拖动窗口时 getBoundingClientRect 出现抖动导致 scale 逐步漂移
      const w = Math.max(1, container.clientWidth)
      const h = Math.max(1, container.clientHeight)
      const dpr = window.devicePixelRatio || 1

      const last = lastLayoutRef.current
      const sizeChanged = w !== last.w || h !== last.h
      const dprChanged = Math.abs(dpr - last.dpr) > 0.001
      const dragging = windowDraggingRef.current
      const forceScale = !dragging && pendingScaleAfterDragRef.current
      if (!sizeChanged && !dprChanged && !forceScale) {
        // 拖动窗口时强制把模型保持在中心，避免合成/缩放抖动造成“视觉漂移”
        if (dragging) {
          const model = modelRef.current
          if (model) model.position.set(w / 2, h / 2 + h * 0.06)
        }
        return
      }

      try {
        if (dprChanged) {
          app.renderer.resolution = dpr
          // 交互坐标也需要跟随 DPR，避免命中/事件偏移
          const interaction = (app.renderer.plugins as unknown as { interaction?: { resolution?: number } }).interaction
          if (interaction && typeof interaction.resolution === 'number') {
            interaction.resolution = dpr
          }
        }

        if (sizeChanged || dprChanged) {
          app.renderer.resize(w, h)
        }

        const model = modelRef.current
        const natural = naturalSizeRef.current
        if (!dragging && model && natural) {
          const padding = 0.92
          const targetW = w * padding
          const targetH = h * padding

          let baseScale = Math.min(targetW / natural.width, targetH / natural.height)
          if (!Number.isFinite(baseScale) || baseScale <= 0 || baseScale > 10) {
            baseScale = 0.15
          }

          // 只在发生“明显变化”时再更新，避免极端拖动/系统抖动导致 scale 频繁微调（观感像越甩越大/越甩越小）
          const currentScale = typeof model.scale?.x === 'number' ? model.scale.x : NaN
          const denom = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1
          const relDiff = Math.abs(baseScale - denom) / denom
          if (!Number.isFinite(currentScale) || relDiff > 0.005) {
            // model.scale 与窗口大小绑定（外部 scale 参数仅作为触发同步的依赖，不在这里叠加）
            model.scale.set(baseScale)
          }

          model.position.set(w / 2, h / 2 + h * 0.06)
        } else if (model) {
          model.position.set(w / 2, h / 2 + h * 0.06)
        }

        lastLayoutRef.current = { w, h, dpr }
        if (dragging && (sizeChanged || dprChanged)) pendingScaleAfterDragRef.current = true
        if (!dragging && forceScale) pendingScaleAfterDragRef.current = false
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

    // 兜底：DPI/缩放变化在某些环境下不会触发 resize/ResizeObserver
    const dprTimer = window.setInterval(() => syncLayout(), 250)

    return () => {
      window.removeEventListener('resize', handleWindowResize)
      if (ro) ro.disconnect()
      clearInterval(dprTimer)
      syncLayoutRef.current = null
    }
  }, [modelLoaded, scale])

  // 拖动窗口时高频同步，避免“甩动时逐步漂移”的观感；结束拖动时再同步一次
  useEffect(() => {
    if (!modelLoaded) return

    const stop = () => {
      if (dragRafRef.current) window.cancelAnimationFrame(dragRafRef.current)
      dragRafRef.current = 0
    }

    if (!windowDragging) {
      stop()
      syncLayoutRef.current?.()
      return
    }

    stop()
    const tick = () => {
      syncLayoutRef.current?.()
      dragRafRef.current = window.requestAnimationFrame(tick)
    }
    dragRafRef.current = window.requestAnimationFrame(tick)

    return stop
  }, [windowDragging, modelLoaded])

  // Update opacity when prop changes or model loads
  useEffect(() => {
    if (modelRef.current && modelLoaded) {
      modelRef.current.alpha = opacity
    }
  }, [opacity, modelLoaded])

  return <div ref={containerRef} className="ndp-live2d-root" />
}
