import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatAttachmentIpcService } from '../electron/ipc/registerChatAttachmentIpc'
import type { IpcHandle } from '../electron/ipc/registration'
import type { IpcChannel } from '../electron/ipcPermissions'

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const roots: string[] = []
const services: ChatAttachmentIpcService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'neodeskpet-chat-attachment-'))
  const userDataDir = path.join(root, 'userData')
  await mkdir(userDataDir, { recursive: true })
  roots.push(root)

  const handlers = new Map<IpcChannel, RegisteredHandler>()
  const handle = ((channel: IpcChannel, listener: RegisteredHandler) => {
    handlers.set(channel, listener)
  }) as IpcHandle
  const service = new ChatAttachmentIpcService(userDataDir, (extension) => `stored${extension}`)
  services.push(service)
  service.register(handle)

  const invoke = <Result = unknown>(channel: IpcChannel, ...args: unknown[]): Result => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`Missing handler: ${channel}`)
    return listener({} as IpcMainInvokeEvent, ...args) as Result
  }

  return { root, userDataDir, handlers, invoke, service }
}

describe('chat attachment IPC registration', () => {
  it('registers the three attachment channels', async () => {
    const harness = await createHarness()
    expect([...harness.handlers.keys()].sort()).toEqual([
      'chat:getAttachmentUrl',
      'chat:readAttachmentDataUrl',
      'chat:saveAttachment',
    ])
  })

  it('stores data URLs and resolves opaque URLs and relative paths', async () => {
    const harness = await createHarness()
    const saved = await harness.invoke<Promise<{
      path: string
      resourceId: string
      filename: string
      mimeType: string
    }>>('chat:saveAttachment', {
      kind: 'image',
      dataUrl: 'data:image/png;base64,AQID',
      filename: 'chosen.png',
    })
    expect(saved).toMatchObject({ filename: 'chosen.png', mimeType: 'image/png' })
    expect(saved.path).toBe(path.join(harness.userDataDir, 'chat-attachments', 'stored.png'))

    const dataResult = await harness.invoke<Promise<{ dataUrl: string }>>(
      'chat:readAttachmentDataUrl',
      { resourceId: saved.resourceId },
    )
    expect(dataResult.dataUrl).toBe('data:image/png;base64,AQID')

    const relativePath = path.relative(harness.userDataDir, saved.path)
    const urlResult = await harness.invoke<Promise<{ url: string; resourceId: string }>>(
      'chat:getAttachmentUrl',
      { path: relativePath },
    )
    expect(urlResult.resourceId).toBe(saved.resourceId)
    expect(urlResult.url).not.toContain('stored.png')
    const response = await fetch(urlResult.url, { headers: { Connection: 'close' } })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]))
  })

  it('copies selected source files into the managed attachment directory', async () => {
    const harness = await createHarness()
    const sourcePath = path.join(harness.root, 'selected.png')
    await writeFile(sourcePath, Buffer.from([4, 5, 6]))

    const saved = await harness.invoke<Promise<{ path: string; mimeType: string }>>('chat:saveAttachment', {
      kind: 'image',
      sourcePath,
      filename: 'selected.png',
    })
    expect(saved.path).toBe(path.join(harness.userDataDir, 'chat-attachments', 'stored.png'))
    expect(saved.mimeType).toBe('image/png')

    const dataResult = await harness.invoke<Promise<{ dataUrl: string }>>('chat:readAttachmentDataUrl', {
      path: saved.path,
    })
    expect(dataResult.dataUrl).toBe('data:image/png;base64,BAUG')
  })

  it('rejects invalid types and hides forbidden filesystem paths', async () => {
    const harness = await createHarness()
    await expect(
      harness.invoke<Promise<unknown>>('chat:saveAttachment', {
        kind: 'video',
        dataUrl: 'data:image/png;base64,AQID',
      }),
    ).rejects.toThrow('unsupported attachment type')

    const textPath = path.join(harness.root, 'notes.txt')
    await writeFile(textPath, 'notes')
    await expect(
      harness.invoke<Promise<unknown>>('chat:saveAttachment', { kind: 'image', sourcePath: textPath }),
    ).rejects.toThrow('unsupported attachment type')

    const outsidePath = path.join(harness.root, 'outside.png')
    await writeFile(outsidePath, Buffer.from([1]))
    const request = harness.invoke<Promise<unknown>>('chat:getAttachmentUrl', { path: outsidePath })
    await expect(request).rejects.toThrow('Local media path is not allowed')
    await expect(request).rejects.not.toThrow(outsidePath)
  })

  it('closes the local server and invalidates issued URLs', async () => {
    const harness = await createHarness()
    const saved = await harness.invoke<Promise<{ resourceId: string }>>('chat:saveAttachment', {
      kind: 'image',
      dataUrl: 'data:image/png;base64,AQID',
    })
    const urlResult = await harness.invoke<Promise<{ url: string }>>('chat:getAttachmentUrl', {
      resourceId: saved.resourceId,
    })
    expect((await fetch(urlResult.url, { headers: { Connection: 'close' } })).status).toBe(200)

    await harness.service.close()
    await expect(fetch(urlResult.url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
  })
})
