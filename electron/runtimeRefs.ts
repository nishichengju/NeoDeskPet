import type { WindowManager } from './windowManager'

let windowManagerRef: WindowManager | null = null

export function setWindowManagerInstance(instance: WindowManager): void {
  windowManagerRef = instance
}

export function getWindowManagerInstance(): WindowManager | null {
  return windowManagerRef
}

