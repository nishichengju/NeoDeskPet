import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { IpcChannel } from '../ipcPermissions'

export type IpcHandle = <Args extends unknown[], Result>(
  channel: IpcChannel,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) => void

export type IpcOn = <Args extends unknown[]>(
  channel: IpcChannel,
  listener: (event: IpcMainEvent, ...args: Args) => void,
) => void
