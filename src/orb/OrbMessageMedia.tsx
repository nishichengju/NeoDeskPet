import { useEffect, useState } from 'react'
import { useVisibleInterval } from '../hooks/useVisibleInterval'
import {
  formatDurationMs,
  getImageFallback,
  getVideoFallback,
  resolveOrbImageSource,
  resolveOrbVideoSource,
  type OrbMediaApi,
} from './orbMessageMediaUtils'

export function ToolUseDuration(props: { startedAt: number; endedAt: number | null }) {
  const startedAt = Number.isFinite(props.startedAt) ? props.startedAt : 0
  const endedAt = typeof props.endedAt === 'number' && Number.isFinite(props.endedAt) ? props.endedAt : null
  const isRunning = startedAt > 0 && endedAt == null
  const [now, setNow] = useState(() => Date.now())

  useVisibleInterval(() => setNow(Date.now()), 1000, isRunning)

  const durationText = startedAt > 0 ? formatDurationMs(Math.max(0, (endedAt ?? now) - startedAt)) : ''
  if (!durationText) return null

  return (
    <span className="ndp-tooluse-duration">
      执行时间 {durationText} <span className="ndp-tooluse-caret"></span>
    </span>
  )
}

export function OrbImagePreview(props: {
  api: OrbMediaApi | null
  imagePath: string
  resourceId?: string
  alt: string
  dataUrl?: string
  className?: string
}) {
  const { api, imagePath, resourceId, alt, dataUrl, className } = props
  const fallback = getImageFallback({ imagePath, resourceId, dataUrl })
  const sourceKey = JSON.stringify([imagePath, resourceId ?? '', dataUrl ?? ''])
  const [resolved, setResolved] = useState(() => ({ key: sourceKey, src: fallback }))
  const src = fallback || (resolved.key === sourceKey ? resolved.src : '')

  useEffect(() => {
    let alive = true
    if (fallback) {
      setResolved({ key: sourceKey, src: fallback })
      return
    }

    void resolveOrbImageSource(api, { imagePath, resourceId, dataUrl }).then((nextSrc) => {
      if (alive) setResolved({ key: sourceKey, src: nextSrc })
    })
    return () => {
      alive = false
    }
  }, [api, dataUrl, fallback, imagePath, resourceId, sourceKey])

  if (!src) return null
  return <img className={className} src={src} alt={alt} />
}

export function OrbLocalVideo(props: {
  api: OrbMediaApi | null
  videoPath: string
  resourceId?: string
  className?: string
  controls?: boolean
  muted?: boolean
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
}) {
  const { api, videoPath, resourceId, className, controls = true, muted, playsInline, preload } = props
  const fallback = getVideoFallback({ videoPath, resourceId })
  const sourceKey = JSON.stringify([videoPath, resourceId ?? ''])
  const [resolved, setResolved] = useState(() => ({ key: sourceKey, src: fallback }))
  const src = fallback || (resolved.key === sourceKey ? resolved.src : '')

  useEffect(() => {
    let alive = true
    if (fallback) {
      setResolved({ key: sourceKey, src: fallback })
      return
    }

    void resolveOrbVideoSource(api, { videoPath, resourceId }).then((nextSrc) => {
      if (alive) setResolved({ key: sourceKey, src: nextSrc })
    })
    return () => {
      alive = false
    }
  }, [api, fallback, resourceId, sourceKey, videoPath])

  if (!src) return null
  return <video className={className} src={src} controls={controls} muted={muted} playsInline={playsInline} preload={preload} />
}
