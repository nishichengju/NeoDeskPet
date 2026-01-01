import { useEffect, useMemo, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'
import { defaultModelJsonUrl } from './live2dModels'
import { getApi } from '../neoDeskPetApi'

type Props = {
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
  const { modelJsonUrl, scale = 1.0, opacity = 1.0, mouthOpen = 0 } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<Live2DModel | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const mouthOpenRef = useRef(0)

  useEffect(() => {
    mouthOpenRef.current = Math.max(0, Math.min(1.25, mouthOpen))
  }, [mouthOpen])

  const selectedModelUrl = useMemo(() => modelJsonUrl ?? defaultModelJsonUrl, [modelJsonUrl])

  // Initialize PIXI and Live2D
  useEffect(() => {
    if (!containerRef.current) return

    setModelLoaded(false)
    ;(window as unknown as { PIXI?: unknown }).PIXI = PIXI

    const rect = containerRef.current.getBoundingClientRect()

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: rect.width,
      height: rect.height,
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

      // Store natural size for later recalculation
      naturalSizeRef.current = {
        width: Math.max(1, live2d.width || 1),
        height: Math.max(1, live2d.height || 1),
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

  // Update scale and resize canvas when prop changes or model loads
  useEffect(() => {
    const model = modelRef.current
    const app = appRef.current
    const natural = naturalSizeRef.current
    const container = containerRef.current

    if (!model || !app || !natural || !container || !modelLoaded) return

    // Get current container size (may have changed due to window resize)
    const rect = container.getBoundingClientRect()

    // Resize PIXI renderer to match container
    app.renderer.resize(rect.width, rect.height)

    // Calculate scale to fit model in container (fill most of the space)
    const padding = 0.92
    const targetW = rect.width * padding
    const targetH = rect.height * padding

    let baseScale = Math.min(targetW / natural.width, targetH / natural.height)
    if (!Number.isFinite(baseScale) || baseScale <= 0 || baseScale > 10) {
      baseScale = 0.15
    }

    // Model always fits the window - scale is handled by window size
    model.scale.set(baseScale)
    model.position.set(rect.width / 2, rect.height / 2 + rect.height * 0.06)
  }, [scale, modelLoaded])

  // Update opacity when prop changes or model loads
  useEffect(() => {
    if (modelRef.current && modelLoaded) {
      modelRef.current.alpha = opacity
    }
  }, [opacity, modelLoaded])

  return <div ref={containerRef} className="ndp-live2d-root" />
}
