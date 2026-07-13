import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  TaskToolMediaStore,
  extractImageRefsFromToolText,
  imageUrlPartsFromPaths,
} from '../electron/task/taskToolMedia'

const roots: string[] = []

function fixture(): { root: string; userDataDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-task-media-'))
  const userDataDir = path.join(root, 'userData')
  mkdirSync(userDataDir)
  roots.push(root)
  return { root, userDataDir }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Task tool media', () => {
  it('prefers explicit JSON image fields, preserves order, and filters remote thumbnails', () => {
    const result = extractImageRefsFromToolText(
      JSON.stringify({
        path: 'C:\\images\\first.png',
        paths: ['C:\\\\images\\\\first.png', '/tmp/second.webp'],
        images: [{ path: 'C:\\images\\third.jpg' }],
        thumbnail: 'https://example.com/ignored.png',
      }),
    )

    expect(result).toEqual(['C:\\images\\first.png', '/tmp/second.webp', 'C:\\images\\third.jpg'])
  })

  it('extracts local and localhost references from free-form output without accepting remote URLs', () => {
    const result = extractImageRefsFromToolText(
      [
        '![local](C:\\captures\\screen.png)',
        'http://127.0.0.1:3210/media/preview.webp',
        'https://example.com/remote.jpg',
        '//cdn.example.com/remote.png',
      ].join('\n'),
    )

    expect(result).toContain('C:\\captures\\screen.png')
    expect(result).toContain('http://127.0.0.1:3210/media/preview.webp')
    expect(result).not.toContain('https://example.com/remote.jpg')
    expect(result).not.toContain('//cdn.example.com/remote.png')
  })

  it('persists bounded raster payloads, validates base64, and deduplicates identical bytes', async () => {
    const dirs = fixture()
    let nextId = 0
    const store = new TaskToolMediaStore({
      userDataDir: dirs.userDataDir,
      maxImageBytes: 8,
      createId: () => `image-${++nextId}`,
    })
    const first = Buffer.from([1, 2, 3, 4])
    const second = Buffer.from([5, 6, 7])

    const paths = await store.persistImages('task:bad/name', [
      { mimeType: 'image/png', data: first.toString('base64') },
      { mimeType: 'image/jpeg', data: first.toString('base64') },
      { mimeType: 'image/jpeg', data: `data:image/jpeg;base64,${second.toString('base64')}` },
      { mimeType: 'image/png', data: 'not-base64!' },
      { mimeType: 'image/png', data: Buffer.alloc(9, 1).toString('base64') },
      { mimeType: 'text/plain', data: second.toString('base64') },
    ])

    expect(paths).toHaveLength(2)
    expect(paths[0]).toMatch(/task_bad_name-image-1\.png$/)
    expect(paths[1]).toMatch(/task_bad_name-image-2\.jpg$/)
    expect(readFileSync(paths[0])).toEqual(first)
    expect(readFileSync(paths[1])).toEqual(second)
  })

  it('prefers structured image payloads and falls back to text references when none are valid', async () => {
    const dirs = fixture()
    let nextId = 0
    const store = new TaskToolMediaStore({ userDataDir: dirs.userDataDir, createId: () => `id-${++nextId}` })
    const fallbackPath = path.join(dirs.root, 'fallback.png')
    writeFileSync(fallbackPath, Buffer.from([9]))

    const persisted = await store.resolveImagePaths(
      'task-1',
      JSON.stringify({ path: fallbackPath }),
      [{ mimeType: 'image/png', data: Buffer.from([1, 2]).toString('base64') }],
    )
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).not.toBe(fallbackPath)

    const fallback = await store.resolveImagePaths(
      'task-1',
      JSON.stringify({ path: fallbackPath }),
      [{ mimeType: 'image/png', data: 'invalid!' }],
    )
    expect(fallback).toEqual([fallbackPath])
  })

  it('builds model image parts from paths, file URLs, inline data, and remote URLs', async () => {
    const dirs = fixture()
    const localPath = path.join(dirs.root, 'local.png')
    const bytes = Buffer.from([1, 2, 3])
    writeFileSync(localPath, bytes)
    const inline = `data:image/jpeg;base64,${Buffer.from([4, 5]).toString('base64')}`

    const parts = await imageUrlPartsFromPaths(
      [localPath, pathToFileURL(localPath).href, inline, 'https://example.com/image.png'],
      4,
    )

    expect(parts).toHaveLength(4)
    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` },
    })
    expect(parts[1]).toEqual(parts[0])
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: inline } })
    expect(parts[3]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/image.png' } })
  })

  it('skips oversized, unsupported, missing, and malformed model image inputs', async () => {
    const dirs = fixture()
    const oversized = path.join(dirs.root, 'large.png')
    const unsupported = path.join(dirs.root, 'vector.svg')
    writeFileSync(oversized, Buffer.alloc(5, 1))
    writeFileSync(unsupported, '<svg/>')

    const parts = await imageUrlPartsFromPaths(
      [
        oversized,
        unsupported,
        path.join(dirs.root, 'missing.png'),
        'data:image/png;base64,invalid!',
      ],
      4,
      { maxImageBytes: 4 },
    )

    expect(parts).toEqual([])
  })
})
