import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitThinkSegments } from '../utils/splitThinkSegments'

export function MarkdownMessage(props: { text: string; className?: string }) {
  const segments = splitThinkSegments(props.text)
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
