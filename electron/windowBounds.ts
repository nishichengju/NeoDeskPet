import type { WindowBounds } from './types'

export type ManagedWindowType = 'chat' | 'settings' | 'memory'

export type WindowSizePolicy = {
  defaultWidth: number
  defaultHeight: number
  minWidth: number
  minHeight: number
}

export const MANAGED_WINDOW_SIZE_POLICIES: Readonly<Record<ManagedWindowType, WindowSizePolicy>> = Object.freeze({
  chat: Object.freeze({ defaultWidth: 720, defaultHeight: 620, minWidth: 420, minHeight: 500 }),
  settings: Object.freeze({ defaultWidth: 860, defaultHeight: 680, minWidth: 640, minHeight: 500 }),
  memory: Object.freeze({ defaultWidth: 900, defaultHeight: 720, minWidth: 640, minHeight: 500 }),
})

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

export function createDefaultManagedWindowBounds(type: ManagedWindowType): WindowBounds {
  const policy = MANAGED_WINDOW_SIZE_POLICIES[type]
  return { width: policy.defaultWidth, height: policy.defaultHeight }
}

export function normalizeManagedWindowBounds(type: ManagedWindowType, value: unknown): WindowBounds {
  const policy = MANAGED_WINDOW_SIZE_POLICIES[type]
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const width = finiteInteger(raw.width) ?? policy.defaultWidth
  const height = finiteInteger(raw.height) ?? policy.defaultHeight
  const x = finiteInteger(raw.x)
  const y = finiteInteger(raw.y)

  return {
    ...(x == null ? {} : { x }),
    ...(y == null ? {} : { y }),
    width: Math.max(policy.minWidth, width),
    height: Math.max(policy.minHeight, height),
  }
}
