import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalMediaError, LocalMediaRegistry } from '../electron/localMediaRegistry'
import { LocalMediaServer, parseSingleByteRange } from '../electron/localMediaServer'

const roots: string[] = []

function fixture(): { root: string; managed: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-media-'))
  const managed = path.join(root, 'managed')
  const outside = path.join(root, 'outside')
  mkdirSync(managed)
  mkdirSync(outside)
  roots.push(root)
  return { root, managed, outside }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local media registry', () => {
  it('registers supported managed files and rejects arbitrary or missing paths', async () => {
    const dirs = fixture()
    const imagePath = path.join(dirs.managed, 'image.png')
    const outsidePath = path.join(dirs.outside, 'secret.png')
    writeFileSync(imagePath, Buffer.from([1, 2, 3]))
    writeFileSync(outsidePath, Buffer.from([4, 5, 6]))
    const registry = new LocalMediaRegistry({ allowedRoots: [dirs.managed] })

    await expect(registry.registerFile(imagePath)).resolves.toMatchObject({ kind: 'image', mimeType: 'image/png', size: 3 })
    await expect(registry.resolveReference({ resourceId: 'stale-id', path: imagePath })).resolves.toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    })
    await expect(registry.registerFile(outsidePath)).rejects.toMatchObject({ code: 'forbidden_path' })
    await expect(registry.registerFile(path.join(dirs.managed, 'missing.png'))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a managed-directory symlink that resolves outside the allowed root', async () => {
    const dirs = fixture()
    const outsideFile = path.join(dirs.outside, 'outside.png')
    writeFileSync(outsideFile, Buffer.from([1]))
    const linkedDirectory = path.join(dirs.managed, 'linked')
    symlinkSync(dirs.outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    const registry = new LocalMediaRegistry({ allowedRoots: [dirs.managed] })

    await expect(registry.registerFile(path.join(linkedDirectory, 'outside.png'))).rejects.toMatchObject({
      code: 'forbidden_path',
    })
  })

  it('enforces type and image data URL limits', async () => {
    const dirs = fixture()
    const textPath = path.join(dirs.managed, 'notes.txt')
    const imagePath = path.join(dirs.managed, 'large.png')
    writeFileSync(textPath, 'notes')
    writeFileSync(imagePath, Buffer.alloc(16, 1))
    const registry = new LocalMediaRegistry({ allowedRoots: [dirs.managed], maxImageBytes: 32 })

    await expect(registry.registerFile(textPath)).rejects.toMatchObject({ code: 'unsupported_type' })
    await expect(registry.readDataUrl(imagePath, 8)).rejects.toMatchObject({ code: 'file_too_large' })
  })
})

describe('local media server', () => {
  it('uses opaque expiring tokens, serves bounded ranges, and invalidates deleted resources', async () => {
    const dirs = fixture()
    const videoPath = path.join(dirs.managed, 'clip.mp4')
    writeFileSync(videoPath, Buffer.from('0123456789'))
    let now = 1000
    let tokenIndex = 0
    const registry = new LocalMediaRegistry({
      allowedRoots: [dirs.managed],
      tokenTtlMs: 5000,
      now: () => now,
      createResourceId: () => 'media_test_resource',
      createToken: () => `opaque_token_${++tokenIndex}_abcdefghijklmnop`,
    })
    const server = new LocalMediaServer(registry, { maxRangeBytes: 4 })

    try {
      const issued = await server.getUrl(videoPath)
      expect(issued.url).toContain('/media/opaque_token_1_')
      expect(issued.url).not.toContain('clip.mp4')
      expect(issued.url).not.toContain('path=')

      const rangeResponse = await fetch(issued.url, { headers: { Range: 'bytes=2-9' } })
      expect(rangeResponse.status).toBe(206)
      expect(rangeResponse.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(await rangeResponse.text()).toBe('2345')

      unlinkSync(videoPath)
      const deletedResponse = await fetch(issued.url)
      expect(deletedResponse.status).toBe(404)

      writeFileSync(videoPath, Buffer.from('abcdefghij'))
      const expiring = await server.getUrl(videoPath)
      now = expiring.expiresAt + 1
      const expiredResponse = await fetch(expiring.url)
      expect(expiredResponse.status).toBe(410)
    } finally {
      await server.close()
    }
  })

  it('parses only one bounded byte range', () => {
    expect(parseSingleByteRange('bytes=2-9', 10, 4)).toEqual({ start: 2, end: 5 })
    expect(parseSingleByteRange('bytes=-3', 10, 4)).toEqual({ start: 7, end: 9 })
    expect(parseSingleByteRange('bytes=20-', 10, 4)).toBeNull()
    expect(parseSingleByteRange('bytes=0-1,4-5', 10, 4)).toBeNull()
  })

  it('returns typed registry errors without exposing paths', () => {
    const error = new LocalMediaError('forbidden_path', 'Local media path is not allowed')
    expect(error.code).toBe('forbidden_path')
    expect(error.message).not.toContain('C:\\')
  })
})
