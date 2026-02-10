import type { WindowType } from '../electron/types'

const allowed: WindowType[] = ['pet', 'chat', 'settings', 'memory', 'orb', 'orb-menu']

export function getWindowType(): WindowType {
  const hash = window.location.hash ?? ''
  const cleaned = hash.replace(/^#\/?/, '').trim()

  if (allowed.includes(cleaned as WindowType)) return cleaned as WindowType
  return 'pet'
}
