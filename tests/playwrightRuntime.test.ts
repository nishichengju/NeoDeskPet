import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMissingPlaywrightBrowserError, resolveManagedBrowsersPath } from '../electron/playwrightRuntime'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'neodeskpet-playwright-'))
  temporaryRoots.push(root)
  return root
}

describe('Playwright runtime browser resolution', () => {
  it('prefers an explicit path, then bundled resources, then the developer cache', async () => {
    const root = await createRoot()
    const bundled = path.join(root, 'resources', 'playwright-browsers')
    const developer = path.join(root, 'workspace', 'playwright-browsers')
    await mkdir(bundled, { recursive: true })
    await mkdir(developer, { recursive: true })

    await expect(
      resolveManagedBrowsersPath({ configured: path.join(root, 'custom'), resourcesPath: '', cwd: root, userDataDir: root }),
    ).resolves.toBe(path.join(root, 'custom'))
    await expect(
      resolveManagedBrowsersPath({ resourcesPath: path.join(root, 'resources'), cwd: path.join(root, 'workspace'), userDataDir: path.join(root, 'data') }),
    ).resolves.toBe(bundled)

    await rm(bundled, { recursive: true, force: true })
    await expect(
      resolveManagedBrowsersPath({ resourcesPath: path.join(root, 'resources'), cwd: path.join(root, 'workspace'), userDataDir: path.join(root, 'data') }),
    ).resolves.toBe(developer)
  })

  it('uses writable user data for compact packages and recognizes missing-browser errors', async () => {
    const root = await createRoot()
    const userDataDir = path.join(root, 'data')
    await expect(
      resolveManagedBrowsersPath({ resourcesPath: path.join(root, 'resources'), cwd: path.join(root, 'app'), userDataDir }),
    ).resolves.toBe(path.join(userDataDir, 'playwright-browsers'))
    expect(isMissingPlaywrightBrowserError(new Error("Executable doesn't exist at browser.exe"))).toBe(true)
    expect(isMissingPlaywrightBrowserError(new Error('navigation timeout'))).toBe(false)
  })
})
