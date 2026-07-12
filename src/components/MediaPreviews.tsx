// 聊天消息中的本地图片/视频预览组件（自 App.tsx 拆出）

import { useState, useEffect } from 'react'
import { getApi } from '../neoDeskPetApi'
import { toLocalMediaSrc } from '../utils/chatMessages'

export function MmvectorImagePreview(props: {
  api: ReturnType<typeof getApi> | null
  imagePath: string
  resourceId?: string
  alt: string
}) {
  const { api, imagePath, resourceId, alt } = props
  const [src, setSrc] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(imagePath ?? '').trim()
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) {
      setSrc(p)
      return
    }
    api
      .readChatAttachmentDataUrl(resourceId ? { resourceId, path: p } : p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.dataUrl === 'string') setSrc(res.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, imagePath, resourceId])

  const finalSrc = src || toLocalMediaSrc(imagePath)
  return finalSrc ? <img className="ndp-mmvector-image" src={finalSrc} alt={alt} loading="lazy" /> : null
}

function useLocalMediaUrl(api: ReturnType<typeof getApi> | null, inputPath: string, resourceId?: string): string {
  const [url, setUrl] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(inputPath ?? '').trim()
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) {
      setUrl(p)
      return
    }
    api
      .getChatAttachmentUrl(resourceId ? { resourceId, path: p } : p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.url === 'string') setUrl(res.url)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, inputPath, resourceId])

  return url || toLocalMediaSrc(inputPath)
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
