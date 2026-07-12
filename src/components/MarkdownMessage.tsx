import { memo, useEffect, useMemo, useState, type ImgHTMLAttributes } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitThinkSegments } from '../utils/splitThinkSegments'
import { getApi } from '../neoDeskPetApi'
import {
  applyMarkdownLocalImagePathCompat,
  decodeLocalPathCompat,
  isAbsoluteLocalPath,
  markdownMediaUrlTransform,
  toLocalMediaSrc,
} from '../utils/markdownMedia'

const localAttachmentUrlCache = new Map<string, { url: string; expiresAt: number }>()

function applyCjkMarkdownCompat(input: string): string {
  const text = String(input ?? '')
  if (!text.includes('**')) return text

  // 兼容中文混排里常见的 `）**下一句` 场景：
  // CommonMark 在“闭合 ** 后紧跟中文文字、且 ** 前一个字符是标点”时，可能把这组 ** 判成非闭合定界符。
  // 这里在闭合 ** 后补一个零宽空格实体，既不影响显示，又能让解析器稳定识别粗体结束。
  return text.replace(
    /(\*\*[^*\n]*?[)\]）】》」』〉〕】!?！？。，、；：:,.])\*\*(?=[\u4E00-\u9FFFA-Za-z0-9])/gu,
    '$1**&#8203;',
  )
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string
}

function MarkdownImage(props: MarkdownImageProps) {
  const { src, alt, ...rest } = props
  const api = useMemo(() => getApi(), [])
  const raw = String(src ?? '').trim()
  const localPath = useMemo(() => decodeLocalPathCompat(raw), [raw])
  const absoluteLocal = useMemo(() => {
    const candidate = localPath || raw
    return isAbsoluteLocalPath(candidate) ? candidate : ''
  }, [localPath, raw])
  const cachedResolved = useMemo(() => {
    if (!absoluteLocal) return ''
    const cached = localAttachmentUrlCache.get(absoluteLocal)
    if (!cached || cached.expiresAt <= Date.now() + 5000) return ''
    return cached.url
  }, [absoluteLocal])
  const localFallback = useMemo(() => (absoluteLocal ? '' : toLocalMediaSrc(raw)), [absoluteLocal, raw])
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => String(cachedResolved || localFallback).trim())

  useEffect(() => {
    const nextBase = String(cachedResolved || localFallback).trim()
    setResolvedSrc((prev) => {
      const current = String(prev ?? '').trim()
      return current === nextBase ? prev : nextBase
    })
  }, [cachedResolved, localFallback])

  useEffect(() => {
    let alive = true
    if (!api || !absoluteLocal || cachedResolved) return () => { alive = false }
    api
      .getChatAttachmentUrl(absoluteLocal)
      .then((res) => {
        if (!alive) return
        if (res?.ok && typeof res.url === 'string' && res.url.trim()) {
          const next = res.url.trim()
          localAttachmentUrlCache.set(absoluteLocal, {
            url: next,
            expiresAt: typeof res.expiresAt === 'number' ? res.expiresAt : Date.now() + 60_000,
          })
          setResolvedSrc((prev) => (String(prev ?? '').trim() === next ? prev : next))
        }
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [api, absoluteLocal, cachedResolved])

  const finalSrc = String(resolvedSrc ?? '').trim() || localFallback
  const mergedClassName = ['ndp-md-image', String(rest.className ?? '').trim()].filter(Boolean).join(' ')
  return finalSrc ? <img {...rest} className={mergedClassName} src={finalSrc} alt={alt ?? ''} loading="lazy" /> : null
}

function MarkdownMessageInner(props: { text: string; className?: string }) {
  const normalizedText = applyMarkdownLocalImagePathCompat(applyCjkMarkdownCompat(props.text))
  const segments = splitThinkSegments(normalizedText)
  const components: Components = {
    a: ({ node, ...rest }) => {
      void node
      return <a {...rest} target="_blank" rel="noreferrer" />
    },
    img: ({ node, ...rest }) => {
      void node
      return <MarkdownImage {...rest} />
    },
  }
  return (
    <div className={['ndp-md', props.className].filter(Boolean).join(' ')}>
      {segments.map((seg, idx) => {
        if (seg.kind === 'think') {
          return (
            <details key={`think-${idx}`} className="ndp-think">
              <summary className="ndp-think-summary">思考过程</summary>
              <div className="ndp-think-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={components}
                  urlTransform={markdownMediaUrlTransform}
                >
                  {seg.content}
                </ReactMarkdown>
              </div>
            </details>
          )
        }

        return (
          <ReactMarkdown
            key={`md-${idx}`}
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={components}
            urlTransform={markdownMediaUrlTransform}
          >
            {seg.content}
          </ReactMarkdown>
        )
      })}
    </div>
  )
}

export const MarkdownMessage = memo(
  MarkdownMessageInner,
  (prev, next) => prev.text === next.text && prev.className === next.className,
)
