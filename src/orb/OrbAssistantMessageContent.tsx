import type { ChatMessageRecord, TaskRecord } from '../../electron/types'
import { MarkdownMessage } from '../components/MarkdownMessage'
import type { NeoDeskPetApi } from '../neoDeskPetApi'
import { OrbToolCard } from './OrbToolCard'
import { resolveOrbMessageBlocks, type OrbImageViewerRequestItem } from './orbMessageContentUtils'

export type OrbAssistantMessageContentProps = {
  api: NeoDeskPetApi | null
  message: ChatMessageRecord
  tasksById: ReadonlyMap<string, TaskRecord>
  onOpenImageViewer: (items: OrbImageViewerRequestItem[], index: number) => void | Promise<void>
}

export function OrbAssistantMessageContent(props: OrbAssistantMessageContentProps) {
  const taskId = String(props.message.taskId ?? '').trim()
  const task = taskId ? props.tasksById.get(taskId) ?? null : null
  const blocks = resolveOrbMessageBlocks(props.message, task)
  let toolSeen = 0
  let statusSeen = 0
  let textSeen = 0

  return blocks.map((block) => {
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (!text) return null
      return <MarkdownMessage key={`${props.message.id}-t-${textSeen++}`} text={text} />
    }
    if (block.type === 'status') {
      const text = String(block.text ?? '').trim()
      if (!text) return null
      return (
        <div key={`${props.message.id}-s-${statusSeen++}`} className="ndp-orbpanel-status">
          {text}
        </div>
      )
    }
    if (block.type === 'tool_use') {
      const runId = block.runId
      const key = runId?.trim() ? `${props.message.id}-u-${runId}` : `${props.message.id}-u-${block.taskId}-${toolSeen++}`
      return (
        <div key={key}>
          <OrbToolCard
            api={props.api}
            taskId={block.taskId}
            runId={runId}
            task={props.tasksById.get(block.taskId) ?? null}
            onOpenImageViewer={props.onOpenImageViewer}
          />
        </div>
      )
    }
    return null
  })
}
