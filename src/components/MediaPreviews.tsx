// 聊天消息中的本地图片/视频预览组件（自 App.tsx 拆出）

import { useState, useEffect } from 'react'
import { getApi } from '../neoDeskPetApi'
import {
  buildLocalMediaReference,
  resolveLocalMediaDataUrl,
  resolveLocalMediaUrl,
} from '../services/localMediaCache'
import { toLocalMediaSrc } from '../utils/chatMessages'

export function MmvectorImagePreview(props: {
  api: ReturnType<typeof getApi> | null
  imagePath: string
  resourceId?: string
  alt: string
}) {
  const { api, imagePath, resourceId, alt } = props
  const fallback = toLocalMediaSrc(imagePath)
  const sourceKey = JSON.stringify([imagePath, resourceId ?? ''])
  const [resolved, setResolved] = useState(() => ({ key: sourceKey, src: fallback }))
  const src = fallback || (resolved.key === sourceKey ? resolved.src : '')

  useEffect(() => {
    let alive = true
    const p = String(imagePath ?? '').trim()
    if (fallback) {
      setResolved({ key: sourceKey, src: fallback })
      return
    }
    if (!api || !p) return
    void resolveLocalMediaDataUrl(api, buildLocalMediaReference(p, resourceId))
      .then((nextSrc) => {
        if (!alive) return
        setResolved({ key: sourceKey, src: nextSrc })
      })
    return () => {
      alive = false
    }
  }, [api, fallback, imagePath, resourceId, sourceKey])

  return src ? <img className="ndp-mmvector-image" src={src} alt={alt} loading="lazy" /> : null
}

function useLocalMediaUrl(api: ReturnType<typeof getApi> | null, inputPath: string, resourceId?: string): string {
  const fallback = toLocalMediaSrc(inputPath)
  const sourceKey = JSON.stringify([inputPath, resourceId ?? ''])
  const [resolved, setResolved] = useState(() => ({ key: sourceKey, src: fallback }))
  const src = fallback || (resolved.key === sourceKey ? resolved.src : '')

  useEffect(() => {
    let alive = true
    const p = String(inputPath ?? '').trim()
    if (fallback) {
      setResolved({ key: sourceKey, src: fallback })
      return
    }
    if (!api || !p) return
    void resolveLocalMediaUrl(api, buildLocalMediaReference(p, resourceId))
      .then((nextSrc) => {
        if (!alive) return
        setResolved({ key: sourceKey, src: nextSrc })
      })
    return () => {
      alive = false
    }
  }, [api, fallback, inputPath, resourceId, sourceKey])

  return src
}

export function LocalVideo(props: {
  api: ReturnType<typeof getApi> | null
  videoPath: string
  resourceId?: string
  className?: string
  controls?: boolean
  muted?: boolean
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
}) {
  const { api, videoPath, resourceId, className, controls = true, muted, playsInline, preload } = props
  const src = useLocalMediaUrl(api, videoPath, resourceId)
  return <video className={className} src={src} controls={controls} muted={muted} playsInline={playsInline} preload={preload} />
}
