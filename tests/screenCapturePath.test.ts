import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fs, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveBrowserScreenshotPath } from '../electron/browserControlService'
import { resolveScreenCaptureOutputPath } from '../electron/screenCaptureService'

const roots: string[] = []

function createFixture(): { root: string; userData: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-screen-path-'))
  const userData = path.join(root, 'userData')
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(userData, 'screenshots'), { recursive: true })
  mkdirSync(outside)
  roots.push(root)
  return { root, userData, outside }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('screen capture output path', () => {
  it('keeps PNG output inside userData/screenshots', async () => {
    const fixture = createFixture()
    const resolved = await resolveScreenCaptureOutputPath({
      userDataDir: fixture.userData,
      path: 'screenshots/nested/capture.png',
    })
    const expectedParent = await fs.realpath(path.join(fixture.userData, 'screenshots', 'nested'))
    expect(resolved).toBe(path.join(expectedParent, 'capture.png'))
    await expect(
      resolveScreenCaptureOutputPath({ userDataDir: fixture.userData, path: path.join(fixture.outside, 'capture.png') }),
    ).rejects.toThrow(/userData\/screenshots/)
  })

  it('rejects a screenshots subdirectory symlink that resolves outside', async () => {
    const fixture = createFixture()
    const linked = path.join(fixture.userData, 'screenshots', 'linked')
    symlinkSync(fixture.outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      resolveScreenCaptureOutputPath({ userDataDir: fixture.userData, path: 'screenshots/linked/capture.png' }),
    ).rejects.toThrow(/托管目录之外/)
  })
})

describe('browser screenshot output path', () => {
  it('allows only task-output and browser-screenshots', async () => {
    const fixture = createFixture()
    await expect(resolveBrowserScreenshotPath(fixture.userData, 'task-output/page.png')).resolves.toMatch(
      /task-output[\\/]page\.png$/,
    )
    await expect(resolveBrowserScreenshotPath(fixture.userData, 'browser-screenshots/page.png')).resolves.toMatch(
      /browser-screenshots[\\/]page\.png$/,
    )
    await expect(resolveBrowserScreenshotPath(fixture.userData, path.join(fixture.outside, 'page.png'))).rejects.toThrow(
      /must stay inside/,
    )
  })

  it('rejects a browser screenshot subdirectory symlink that resolves outside', async () => {
    const fixture = createFixture()
    const taskOutput = path.join(fixture.userData, 'task-output')
    mkdirSync(taskOutput, { recursive: true })
    const linked = path.join(taskOutput, 'linked')
    symlinkSync(fixture.outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveBrowserScreenshotPath(fixture.userData, 'task-output/linked/page.png')).rejects.toThrow(
      /outside managed storage/,
    )
  })
})
