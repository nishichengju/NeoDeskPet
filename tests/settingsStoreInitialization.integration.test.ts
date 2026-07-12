import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import packageJson from '../package.json'
import { getSettings, initializeSettingsStore, setSettings } from '../electron/store'
import { SETTINGS_FILE_NAME } from '../electron/settingsMigrationSafety'

const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-store-init-'))
const userDataDir = path.join(root, 'neodeskpet-electron')
const settingsPath = path.join(userDataDir, SETTINGS_FILE_NAME)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('settings store initialization', () => {
  it('migrates through the protected path before electron-store reads the file', () => {
    mkdirSync(userDataDir)
    writeFileSync(
      settingsPath,
      JSON.stringify({
        alwaysOnTop: false,
        petScale: 1.5,
        bubble: { position: 'top-left', showOnChat: false },
      }),
      'utf8',
    )
    writeFileSync(path.join(userDataDir, 'neodeskpet-chat.sqlite3'), 'chat-db', 'utf8')

    const first = initializeSettingsStore({
      userDataDir,
      targetVersion: packageJson.version,
    })
    const settings = getSettings()
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      __internal__: { migrations: { version: string } }
    }

    expect(first.assessment.status).toBe('migrate')
    expect(first.backupPath).toBeTruthy()
    expect(existsSync(path.join(first.backupPath ?? '', 'userData', 'neodeskpet-chat.sqlite3'))).toBe(true)
    expect(persisted.__internal__.migrations.version).toBe(packageJson.version)
    expect(settings.alwaysOnTop).toBe(false)
    expect(settings.petScale).toBe(1.5)
    expect(settings.bubble).toMatchObject({ positionX: 5, positionY: 10, showOnChat: false })

    setSettings({ clickThrough: true })
    const afterUserWrite = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      clickThrough: boolean
      __internal__: { migrations: { version: string } }
    }
    expect(afterUserWrite.clickThrough).toBe(true)
    expect(afterUserWrite.__internal__.migrations.version).toBe(packageJson.version)

    const second = initializeSettingsStore({
      userDataDir,
      targetVersion: packageJson.version,
    })
    expect(second).toEqual(first)
  })
})
