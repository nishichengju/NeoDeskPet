import { lazy, Suspense } from 'react'

export type DeferredMarkdownMessageProps = {
  text: string
  className?: string
}

const MarkdownMessage = lazy(() =>
  import('./MarkdownMessage').then((module) => ({ default: module.MarkdownMessage })),
)

function MarkdownFallback(props: DeferredMarkdownMessageProps) {
  return (
    <div className={['ndp-md', 'ndp-md-pending', props.className].filter(Boolean).join(' ')} data-markdown-pending="true">
      {props.text}
    </div>
  )
}

export function DeferredMarkdownMessage(props: DeferredMarkdownMessageProps) {
  if (typeof window === 'undefined') return <MarkdownFallback {...props} />
  return (
    <Suspense fallback={<MarkdownFallback {...props} />}>
      <MarkdownMessage {...props} />
    </Suspense>
  )
}
