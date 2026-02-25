import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitThinkSegments } from '../utils/splitThinkSegments'

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

export function MarkdownMessage(props: { text: string; className?: string }) {
  const normalizedText = applyCjkMarkdownCompat(props.text)
  const segments = splitThinkSegments(normalizedText)
  const components: Components = {
    a: ({ node, ...rest }) => {
      void node
      return <a {...rest} target="_blank" rel="noreferrer" />
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
                  {seg.content}
                </ReactMarkdown>
              </div>
            </details>
          )
        }

        return (
          <ReactMarkdown key={`md-${idx}`} remarkPlugins={[remarkGfm]} skipHtml components={components}>
            {seg.content}
          </ReactMarkdown>
        )
      })}
    </div>
  )
}
