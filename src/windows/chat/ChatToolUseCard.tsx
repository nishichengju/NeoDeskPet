import type { TaskRecord, TaskStepRecord } from '../../../electron/types'
import { LocalVideo, MmvectorImagePreview } from '../../components/MediaPreviews'
import type { NeoDeskPetApi } from '../../neoDeskPetApi'
import { filterVisibleToolRuns, isAgentShellToolName } from '../../utils/chatMessages'
import { Fragment, useState } from 'react'
import { isPreviewableToolImagePath, parseMmvectorResults, toToolMediaSrc } from './toolUseMedia'

export type ChatToolUseCardProps = {
  task: TaskRecord | null
  runId?: string
  api: NeoDeskPetApi | null
  messageId: string
  onOpenImageViewer: (paths: string[], index: number) => void | Promise<void>
  onRerollImageGenerate: (
    inputPreview: string,
    context?: { taskId?: string; runId?: string; messageId?: string; oldImagePaths?: string[] },
  ) => Promise<string[]>
}

async function openMediaTarget(api: NeoDeskPetApi | null, target: string): Promise<void> {
  const raw = String(target ?? '').trim()
  if (!raw) return
  if (/^(https?:|data:|blob:)/i.test(raw)) {
    window.open(raw, '_blank')
    return
  }
  if (!api) return
  try {
    const result = await api.getChatAttachmentUrl(raw)
    if (result?.ok && typeof result.url === 'string') window.open(result.url, '_blank')
  } catch {
    // Media previews keep their own load failure state.
  }
}

export function ChatToolUseCard({
  task,
  runId,
  api,
  messageId,
  onOpenImageViewer,
  onRerollImageGenerate,
}: ChatToolUseCardProps) {
  const [rerollingRuns, setRerollingRuns] = useState<Record<string, true>>({})
  const [rerolledImagePaths, setRerolledImagePaths] = useState<Record<string, string[]>>({})
  if (!task) return null

  const runs = filterVisibleToolRuns(Array.isArray(task.toolRuns) ? task.toolRuns : [])
  const steps = (Array.isArray(task.steps) ? task.steps : []).filter((step) => !isAgentShellToolName(step?.tool))

  const renderRun = (run: (typeof runs)[number], index: number) => {
    const progress = runs.length > 1 ? `${index + 1}/${runs.length}` : ''
    const pillStatus = run.status === 'error' ? 'failed' : run.status
    const runKey = String(run.id ?? `${index}`)
    const rerolling = rerollingRuns[runKey] === true
    const rerollForRun = async () => {
      if (!run.inputPreview || rerolling) return
      setRerollingRuns((previous) => ({ ...previous, [runKey]: true }))
      try {
        const nextPaths = await onRerollImageGenerate(run.inputPreview, {
          taskId: task.id,
          runId: String(run.id ?? ''),
          messageId,
          oldImagePaths: Array.isArray(run.imagePaths) ? run.imagePaths.filter(Boolean) : [],
        })
        if (nextPaths.length > 0) setRerolledImagePaths((previous) => ({ ...previous, [runKey]: nextPaths }))
      } finally {
        setRerollingRuns((previous) => {
          const next = { ...previous }
          delete next[runKey]
          return next
        })
      }
    }

    const rawToolImagePaths = rerolledImagePaths[runKey] ?? run.imagePaths
    const toolImagePaths = Array.isArray(rawToolImagePaths)
      ? Array.from(
          new Set(
            rawToolImagePaths
              .map((value) => String(value ?? '').trim())
              .filter((value) => value && isPreviewableToolImagePath(value)),
          ),
        ).slice(0, run.toolName === 'image.generate' ? 1 : 8)
      : []
    const mmvector = run.outputPreview ? parseMmvectorResults(run.outputPreview) : null
    const mmMedia =
      mmvector?.results.filter((item) => {
        const type = String(item?.type ?? '')
        if (type === 'video') return String(item?.videoUrl ?? '').trim() || String(item?.videoPath ?? '').trim()
        if (type === 'image') return String(item?.imagePath ?? '').trim()
        return false
      }) ?? []

    return (
      <Fragment key={runKey}>
        {toolImagePaths.length > 0 ? (
          <div className="ndp-mmvector-results">
            <div className="ndp-mmvector-title">工具输出图片（可预览）</div>
            <div className="ndp-mmvector-grid">
              {toolImagePaths.map((imagePath, imageIndex) => (
                <div key={`tool-img-${runKey}-${imageIndex}`} className="ndp-mmvector-item">
                  <div
                    className="ndp-mmvector-image-hit"
                    onClick={() => void onOpenImageViewer(toolImagePaths, imageIndex)}
                    title={imagePath}
                  >
                    <MmvectorImagePreview api={api} imagePath={imagePath} alt={`tool-image-${imageIndex + 1}`} />
                  </div>
                  <div className="ndp-mmvector-meta" title={imagePath}>
                    image {imageIndex + 1}
                  </div>
                </div>
              ))}
            </div>
            {run.toolName === 'image.generate' && run.inputPreview ? (
              <div className="ndp-mmvector-actions ndp-mmvector-actions-left">
                <button className="ndp-btn ndp-btn-mini" type="button" disabled={rerolling} onClick={() => void rerollForRun()}>
                  {rerolling ? '正在生成' : '重新生成'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <details className="ndp-tooluse">
          <summary className="ndp-tooluse-summary">
            <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
              DeskPet · ToolUse: {run.toolName}
              {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
            </span>
          </summary>
          <div className="ndp-tooluse-body">
            <div className="ndp-tooluse-run">
              <div className="ndp-tooluse-run-title">
                <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${run.status}`}>{run.status}</span>
                <span className="ndp-tooluse-run-name">{run.toolName}</span>
              </div>
              {run.inputPreview ? <div className="ndp-tooluse-run-io">in: {run.inputPreview}</div> : null}
              {run.outputPreview ? <div className="ndp-tooluse-run-io">out: {run.outputPreview}</div> : null}
              {run.toolName === 'image.generate' && run.inputPreview && toolImagePaths.length === 0 ? (
                <div className="ndp-tooluse-run-actions">
                  <button className="ndp-btn ndp-btn-mini" type="button" disabled={rerolling} onClick={() => void rerollForRun()}>
                    {rerolling ? '正在生成' : '重新生成'}
                  </button>
                </div>
              ) : null}
              {mmMedia.length > 0 ? (
                <div className="ndp-mmvector-results">
                  <div className="ndp-mmvector-title">多模态结果（可预览/播放）</div>
                  <div className="ndp-mmvector-grid">
                    {mmMedia.map((item) => {
                      const isVideo = String(item.type ?? '') === 'video'
                      const source = isVideo
                        ? toToolMediaSrc(String(item.videoUrl ?? ''), String(item.videoPath ?? ''))
                        : toToolMediaSrc('', String(item.imagePath ?? ''))
                      if (!source) return null
                      const labelParts: string[] = []
                      if (item.filename) labelParts.push(String(item.filename))
                      if (typeof item.score === 'number' && Number.isFinite(item.score)) labelParts.push(item.score.toFixed(4))
                      const label = labelParts.join(' · ')
                      return (
                        <div key={`mmv-${String(item.id ?? '')}-${source}`} className="ndp-mmvector-item">
                          {isVideo ? (
                            <LocalVideo api={api} videoPath={source} className="ndp-mmvector-video" controls preload="metadata" playsInline />
                          ) : (
                            <MmvectorImagePreview api={api} imagePath={String(item.imagePath ?? '')} alt={String(item.filename ?? 'image')} />
                          )}
                          <div className="ndp-mmvector-meta" title={source}>
                            {label || source}
                          </div>
                          <div className="ndp-mmvector-actions">
                            <button
                              className="ndp-btn ndp-btn-mini"
                              onClick={() => {
                                const target = isVideo
                                  ? String(item.videoUrl ?? '').trim() || String(item.videoPath ?? '').trim() || source
                                  : String(item.imagePath ?? '').trim() || source
                                void openMediaTarget(api, target)
                              }}
                            >
                              打开
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
              {run.error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {run.error}</div> : null}
            </div>
          </div>
        </details>
      </Fragment>
    )
  }

  const renderStep = (step: TaskStepRecord, index: number) => {
    const toolName = String(step.tool ?? '').trim()
    const name = toolName || step.title
    const input = String(step.input ?? '').trim()
    const output = String(step.output ?? '').trim()
    const error = String(step.error ?? '').trim()
    const statusText = String(step.status ?? '').trim() || 'pending'
    const statusKey = statusText === 'failed' ? 'error' : statusText === 'skipped' ? 'disconnected' : statusText
    const progress = steps.length > 1 ? `${index + 1}/${steps.length}` : ''
    const pillStatus =
      statusText === 'failed'
        ? 'failed'
        : statusText === 'done'
          ? 'done'
          : statusText === 'running'
            ? 'running'
            : statusText === 'paused'
              ? 'paused'
              : 'pending'

    return (
      <details key={step.id || `${task.id}-step-${index}`} className="ndp-tooluse">
        <summary className="ndp-tooluse-summary">
          <span className={`ndp-tooluse-pill ndp-tooluse-pill-${pillStatus}`}>
            DeskPet · ToolUse: {name}
            {progress ? <span style={{ opacity: 0.8 }}>{progress}</span> : null}
          </span>
        </summary>
        <div className="ndp-tooluse-body">
          <div className="ndp-tooluse-run">
            <div className="ndp-tooluse-run-title">
              <span className={`ndp-tooluse-run-status ndp-tooluse-run-status-${statusKey}`}>{statusText}</span>
              <span className="ndp-tooluse-run-name">{name}</span>
            </div>
            {input ? <div className="ndp-tooluse-run-io">in: {input}</div> : null}
            {output ? <div className="ndp-tooluse-run-io">out: {output}</div> : null}
            {error ? <div className="ndp-tooluse-run-io ndp-tooluse-run-error">err: {error}</div> : null}
          </div>
        </div>
      </details>
    )
  }

  if (runId) {
    const index = runs.findIndex((run) => String(run.id ?? '') === runId)
    return index >= 0 ? renderRun(runs[index], index) : null
  }
  if (runs.length > 0) return <>{runs.map((run, index) => renderRun(run, index))}</>
  if (steps.length > 0) return <>{steps.map((step, index) => renderStep(step, index))}</>
  return null
}
