import type { WindowType } from './types'

export type IpcWindowPermission = readonly WindowType[]

export function isIpcWindowAllowed(senderWindowType: WindowType | null | undefined, allowed: IpcWindowPermission): boolean {
  return senderWindowType != null && allowed.includes(senderWindowType)
}

export function assertIpcWindowAllowed(
  channel: string,
  senderWindowType: WindowType | null | undefined,
  allowed: IpcWindowPermission,
): asserts senderWindowType is WindowType {
  if (isIpcWindowAllowed(senderWindowType, allowed)) return
  const sender = senderWindowType ?? 'unknown'
  throw new Error(`IPC sender is not allowed: channel=${channel}; sender=${sender}`)
}
