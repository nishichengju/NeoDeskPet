import type { ChatSessionSummary } from '../../electron/types'

export const ORB_HISTORY_POPOVER_WIDTH = 320
export const ORB_HISTORY_POPOVER_TOP = 90
export const ORB_HISTORY_POPOVER_RADIUS = 16
export const ORB_HISTORY_MAX_ITEMS = 8

export type OrbHistoryItem = {
  id: string
  name: string
  messageCount: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function getOrbHistoryPopoverPosition(anchorCenterX: number, viewportWidth: number) {
  const barWidth = Math.max(360, Math.round(viewportWidth))
  const anchor = Number.isFinite(anchorCenterX) ? anchorCenterX : barWidth / 2
  const left = clamp(
    Math.round(anchor - ORB_HISTORY_POPOVER_WIDTH / 2),
    10,
    barWidth - ORB_HISTORY_POPOVER_WIDTH - 10,
  )
  const arrowX = clamp(anchor, left + 16, left + ORB_HISTORY_POPOVER_WIDTH - 16)
  return { left, top: ORB_HISTORY_POPOVER_TOP, arrowX: Math.round(arrowX - left) }
}

export function buildOrbHistoryItems(
  sessions: ChatSessionSummary[],
  personaId: string,
): OrbHistoryItem[] {
  const targetPersonaId = personaId.trim() || 'default'
  return sessions
    .filter((session) => session.personaId === targetPersonaId)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, ORB_HISTORY_MAX_ITEMS)
    .map((session) => ({
      id: session.id,
      name: session.name || '未命名会话',
      messageCount: session.messageCount ?? 0,
    }))
}
