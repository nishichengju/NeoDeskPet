export const ORB_MESSAGE_MENU_WIDTH = 188
export const ORB_MESSAGE_MENU_ITEM_HEIGHT = 36
export const ORB_MESSAGE_MENU_PADDING = 8
export const ORB_MESSAGE_MENU_RADIUS = 14

export type OrbMessageMenuBounds = {
  left: number
  top: number
  width: number
  height: number
}

export type OrbMessageMenuPositionInput = {
  clientX: number
  clientY: number
  rootBounds: OrbMessageMenuBounds | null
  role?: 'user' | 'assistant'
  viewportWidth?: number
  viewportHeight?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

export function getOrbMessageMenuPosition(input: OrbMessageMenuPositionInput): { left: number; top: number } {
  const itemCount = input.role === 'assistant' ? 5 : 4
  const menuHeight = ORB_MESSAGE_MENU_PADDING * 2 + itemCount * ORB_MESSAGE_MENU_ITEM_HEIGHT
  const maxWidth = input.rootBounds?.width ?? input.viewportWidth ?? (typeof window === 'undefined' ? 0 : window.innerWidth)
  const maxHeight = input.rootBounds?.height ?? input.viewportHeight ?? (typeof window === 'undefined' ? 0 : window.innerHeight)
  const clientX = finite(input.clientX)
  const clientY = finite(input.clientY)
  const rawX = input.rootBounds ? clientX - input.rootBounds.left : clientX
  const rawY = input.rootBounds ? clientY - input.rootBounds.top : clientY
  return {
    left: clamp(Math.round(rawX), 10, Math.max(10, Math.round(maxWidth - ORB_MESSAGE_MENU_WIDTH - 10))),
    top: clamp(Math.round(rawY), 10, Math.max(10, Math.round(maxHeight - menuHeight - 10))),
  }
}
