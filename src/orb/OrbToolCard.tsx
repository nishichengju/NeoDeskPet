import { Fragment } from 'react'
import type { TaskRecord } from '../../electron/types'
import type { NeoDeskPetApi } from '../neoDeskPetApi'
import { filterVisibleToolRuns, isAgentShellToolName } from '../utils/chatMessages'
import { OrbImagePreview, ToolUseDuration } from './OrbMessageMedia'
import type { OrbImageViewerRequestItem } from './orbMessageContentUtils'

export type OrbToolCardProps = {
  api: NeoDeskPetApi | null
  taskId: string
  runId?: string
  task: TaskRecord | null
  onOpenImageViewer: (items: OrbImageViewerRequestItem[], index: number) => void | Promise<void>
}

export function OrbToolCard(props: OrbToolCardProps) {
  const task = props.task
  if (!task) return <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: ToolUse（任务未加载）</div>

  const runs = filterVisibleToolRuns(Array.isArray(task.toolRuns) ? task.toolRuns : [])
  const steps = (Array.isArray(task.steps) ? task.steps : []).filter(
    (step) => !isAgentShellToolName((step as { tool?: unknown })?.tool),
  )
  const allToolImagePaths = Array.from(
    new Set(
      runs.flatMap((run) =>
        Array.isArray(run.imagePaths)
          ? run.imagePaths.map((path) => String(path ?? '').trim()).filter(Boolean).slice(0, 8)
          : [],
      ),
    ),
  )
  const toolImageViewerItems = allToolImagePaths.map((source, index) => ({ source, title: `图片 ${index + 1}` }))

  const renderRun = (run: (typeof runs)[number], index: number) => {
    const runKey = String(run.id ?? `${props.taskId}-run-${index}`)
    const progress = runs.length > 1 ? `${index + 1}/${runs.length}` : ''
    const pillStatus = run.status === 'error' ? 'failed' : run.status
    const imagePaths = Array.isArray(run.imagePaths)
      ? Array.from(new Set(run.imagePaths.map((path) => String(path ?? '').trim()).filter(Boolean))).slice(0, 8)
      : []
    const startedAt = typeof run.startedAt === 'number' ? run.startedAt : 0
    const endedAt = typeof run.endedAt === 'number' ? run.endedAt : null

    return (
      <Fragment key={runKey}>
        {imagePaths.length > 0 ? (
          <div className="ndp-orbpanel-attachments" data-orb-nodrag="true">
            {imagePaths.map((imagePath, imageIndex) => (
              <div
                key={`tool-outside-img-${runKey}-${imageIndex}`}
                className="ndp-orbpanel-attachment"
                title={imagePath}
                onClick={() => {
                  const viewerIndex = allToolImagePaths.findIndex((path) => path === imagePath)
                  void props.onOpenImageViewer(toolImageViewerItems, viewerIndex >= 0 ? viewerIndex : imageIndex)
                }}
              >
                <OrbImagePreview
                  api={props.api}
                  className="ndp-orbpanel-image"
                  imagePath={imagePath}
                  alt={`tool-image-${imageIndex + 1}`}
                />
                <div className="ndp-orbpanel-attachment-meta">image {imageIndex + 1}</div>
              </div>
            ))}
          </div>
        ) : null}
        <details className="ndp-tooluse">
          <summary className="ndp-tooluse-summary">
            <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
              DeskPet · ToolUse: {run.toolName}
              {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
            </span>
            <ToolUseDuration startedAt={startedAt} endedAt={endedAt} />
          </summary>
          <div className="ndp-tooluse-body">
            <div className="ndp-tooluse-run">
              <div className="ndp-tooluse-run-title">
                <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${run.status}`}>{run.status}</span>
                <span className="ndp-tooluse-run-name">{run.toolName}</span>
              </div>
              {run.inputPreview ? <div className="ndp-tooluse-run-io">in: {run.inputPreview}</div> : null}
              {run.outputPreview ? <div className="ndp-tooluse-run-io">out: {run.outputPreview}</div> : null}
              {run.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {run.error}</div> : null}
            </div>
          </div>
        </details>
      </Fragment>
    )
  }

  const renderStep = (step: (typeof steps)[number], index: number) => {
    const tool = typeof step.tool === 'string' ? step.tool : ''
    const name = tool || String(step.title ?? `step-${index}`)
    const progress = steps.length > 1 ? `${index + 1}/${steps.length}` : ''
    const statusText = String(step.status ?? 'pending')
    const statusKey =
      statusText === 'error'
        ? 'error'
        : statusText === 'done'
          ? 'done'
          : statusText === 'running'
            ? 'running'
            : statusText === 'paused'
              ? 'paused'
              : 'pending'
    const pillStatus =
      statusText === 'failed' || statusText === 'error'
        ? 'failed'
        : statusText === 'done'
          ? 'done'
          : statusText === 'running'
            ? 'running'
            : statusText === 'paused'
              ? 'paused'
              : 'pending'
    const startedAt = typeof step.startedAt === 'number' ? step.startedAt : 0
    const endedAt = typeof step.endedAt === 'number' ? step.endedAt : null

    return (
      <details key={String(step.id ?? `${props.taskId}-step-${index}`)} className="ndp-tooluse">
        <summary className="ndp-tooluse-summary">
          <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
            DeskPet · ToolUse: {name}
            {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
          </span>
          <ToolUseDuration startedAt={startedAt} endedAt={endedAt} />
        </summary>
        <div className="ndp-tooluse-body">
          <div className="ndp-tooluse-run">
            <div className="ndp-tooluse-run-title">
              <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${statusKey}`}>{statusText}</span>
              <span className="ndp-tooluse-run-name">{name}</span>
            </div>
            {step.input ? <div className="ndp-tooluse-run-io">in: {step.input}</div> : null}
            {step.output ? <div className="ndp-tooluse-run-io">out: {step.output}</div> : null}
            {step.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {step.error}</div> : null}
          </div>
        </div>
      </details>
    )
  }

  if (props.runId) {
    const index = runs.findIndex((run) => String(run.id ?? '') === props.runId)
    return index >= 0 ? renderRun(runs[index], index) : null
  }
  if (runs.length > 0) return <>{runs.map((run, index) => renderRun(run, index))}</>

  const usefulSteps = steps.filter((step) => Boolean(step.tool || step.output || step.error))
  if (usefulSteps.length > 0) return <>{usefulSteps.map((step, index) => renderStep(step, index))}</>
  if (task.lastError) return <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {task.lastError}</div>
  return null
}
