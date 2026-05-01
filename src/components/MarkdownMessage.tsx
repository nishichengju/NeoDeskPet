import { memo, useEffect, useMemo, useState, type ImgHTMLAttributes } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitThinkSegments } from '../utils/splitThinkSegments'
import { getApi } from '../neoDeskPetApi'

const localAttachmentUrlCache = new Map<string, string>()

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

function applyMarkdownLocalImagePathCompat(input: string): string {
  const text = String(input ?? '')
  if (!text.includes('![')) return text

  // 兼容 `![alt](C:\path\to\img.png)`：
  // Markdown 会把反斜杠当转义，导致 src 失真。这里在渲染前把 Windows 路径规范成正斜杠。
  return text.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (_m, prefix: string, rawPath: string, suffix: string) => {
    const dest = String(rawPath ?? '').trim()
    if (!dest) return `${prefix}${rawPath}${suffix}`

    // 已经是 URL / data / file 协议时不改
    if (/^(https?:|data:|blob:|file:)/i.test(dest)) return `${prefix}${dest}${suffix}`

    if (/^[a-zA-Z]:\\/.test(dest)) {
      const normalized = dest.replace(/\\/g, '/').replace(/ /g, '%20')
      return `${prefix}${normalized}${suffix}`
    }

    if (/^\\\\/.test(dest)) {
      const normalized = dest.replace(/\\/g, '/').replace(/ /g, '%20')
      return `${prefix}${normalized}${suffix}`
    }

    return `${prefix}${dest}${suffix}`
  })
}

function decodeLocalPathCompat(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text
  if (!isAbsoluteLocalPath(text)) return text
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

function toLocalMediaSrc(mediaPath: string): string {
  const p = String(mediaPath ?? '').trim()
  if (!p) return ''
  if (/^(https?:|file:|data:|blob:)/i.test(p)) return p
  if (/^[a-zA-Z]:[\\/]/.test(p)) return `file:///${p.replace(/\\/g, '/')}`
  if (p.startsWith('\\\\')) return `file:${p.replace(/\\/g, '/')}`
  if (p.startsWith('/')) return `file://${p}`
  return p
}

function isAbsoluteLocalPath(raw: string): boolean {
  const p = String(raw ?? '').trim()
  if (!p) return false
  if (/^(https?:|file:|data:|blob:)/i.test(p)) return false
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
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
  const cachedResolved = useMemo(
    () => (absoluteLocal ? localAttachmentUrlCache.get(absoluteLocal) : ''),
    [absoluteLocal],
  )
  const localFallback = useMemo(() => toLocalMediaSrc(absoluteLocal || raw), [absoluteLocal, raw])
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
          localAttachmentUrlCache.set(absoluteLocal, next)
          setResolvedSrc((prev) => (String(prev ?? '').trim() === next ? prev : next))
        }
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [api, absoluteLocal, cachedResolved])

  const finalSrc = String(resolvedSrc ?? '').trim() || localFallback || raw
  const mergedClassName = ['ndp-md-image', String(rest.className ?? '').trim()].filter(Boolean).join(' ')
  return <img {...rest} className={mergedClassName} src={finalSrc} alt={alt ?? ''} loading="lazy" />
}

function markdownUrlTransform(url: string): string {
  const raw = String(url ?? '').trim()
  if (!raw) return ''

  // react-markdown 默认会把 `C:/...` 判定成不安全协议，导致 src 变成空字符串。
  // 这里保留本地绝对路径，再交给 MarkdownImage 做本地文件 URL 映射。
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return raw.replace(/\\/g, '/')
  if (/^\\\\/.test(raw)) return raw.replace(/\\/g, '/')
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw

  return defaultUrlTransform(raw)
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
                  urlTransform={markdownUrlTransform}
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
            urlTransform={markdownUrlTransform}
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
