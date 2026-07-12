// 聊天消息中的本地图片/视频预览组件（自 App.tsx 拆出）

import { useState, useEffect } from 'react'
import { getApi } from '../neoDeskPetApi'
import { toLocalMediaSrc } from '../utils/chatMessages'

export function MmvectorImagePreview(props: { api: ReturnType<typeof getApi> | null; imagePath: string; alt: string }) {
  const { api, imagePath, alt } = props
  const [src, setSrc] = useState<string>('')

  useEffect(() => {
    let alive = true
    const p = String(imagePath ?? '').trim()
    if (!api || !p) return
    if (/^(https?:|data:|blob:)/i.test(p)) return
    api
      .readChatAttachmentDataUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.dataUrl === 'string') setSrc(res.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, imagePath])

  return <img className="ndp-mmvector-image" src={src || toLocalMediaSrc(imagePath)} alt={alt} loading="lazy" />
}

function useLocalMediaUrl(api: ReturnType<typeof getApi> | null, inputPath: string): string {
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
      .getChatAttachmentUrl(p)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.url === 'string') setUrl(res.url)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, inputPath])

  return url || toLocalMediaSrc(inputPath)
}

export function LocalVideo(props: {
  api: ReturnType<typeof getApi> | null
  videoPath: string
  className?: string
  controls?: boolean
  muted?: boolean
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
}) {
  const { api, videoPath, className, controls = true, muted, playsInline, preload } = props
  const src = useLocalMediaUrl(api, videoPath)
  return <video className={className} src={src} controls={controls} muted={muted} playsInline={playsInline} preload={preload} />
}
