import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SETTINGS_FILE_NAME,
  SettingsMigrationProtectionError,
  assessSettingsMigration,
  runProtectedSettingsInitialization,
} from '../electron/settingsMigrationSafety'

const temporaryRoots: string[] = []

function createUserData(): { root: string; userDataDir: string; settingsPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'neodeskpet-settings-'))
  const userDataDir = path.join(root, 'neodeskpet-electron')
  mkdirSync(userDataDir)
  temporaryRoots.push(root)
  return {
    root,
    userDataDir,
    settingsPath: path.join(userDataDir, SETTINGS_FILE_NAME),
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('settings migration safety', () => {
  it('distinguishes fresh, pending, current, downgrade, and invalid settings', () => {
    const fixture = createUserData()
    expect(assessSettingsMigration(fixture.settingsPath, '0.21.0').status).toBe('fresh')

    writeFileSync(fixture.settingsPath, JSON.stringify({ alwaysOnTop: false }))
    expect(assessSettingsMigration(fixture.settingsPath, '0.21.0')).toMatchObject({
      status: 'migrate',
      previousVersion: '0.0.0',
    })

    writeFileSync(
      fixture.settingsPath,
      JSON.stringify({ __internal__: { migrations: { version: '0.21.0' } } }),
    )
    expect(assessSettingsMigration(fixture.settingsPath, '0.21.0').status).toBe('current')
    expect(assessSettingsMigration(fixture.settingsPath, '0.20.0').status).toBe('downgrade')

    writeFileSync(fixture.settingsPath, '{broken json')
    expect(assessSettingsMigration(fixture.settingsPath, '0.21.0').status).toBe('invalid')
  })

  it('backs up all user data and restores the original settings when migration fails', () => {
    const fixture = createUserData()
    const originalSettings = JSON.stringify({ alwaysOnTop: false, ai: { model: 'legacy-model' } }, null, 2)
    writeFileSync(fixture.settingsPath, originalSettings)
    writeFileSync(path.join(fixture.userDataDir, 'neodeskpet-chat.sqlite3'), 'chat-db')
    mkdirSync(path.join(fixture.userDataDir, 'chat-attachments'))
    writeFileSync(path.join(fixture.userDataDir, 'chat-attachments', 'image.txt'), 'attachment')

    let caught: SettingsMigrationProtectionError | null = null
    try {
      runProtectedSettingsInitialization({
        userDataDir: fixture.userDataDir,
        targetVersion: '0.21.0',
        now: new Date('2026-07-13T05:00:00.000Z'),
        backupId: 'failure',
        initialize: () => {
          writeFileSync(fixture.settingsPath, JSON.stringify({ migrated: true }))
          throw new Error('synthetic migration failure')
        },
      })
    } catch (error) {
      caught = error as SettingsMigrationProtectionError
    }

    expect(caught).toBeInstanceOf(SettingsMigrationProtectionError)
    expect(caught?.message).toContain('synthetic migration failure')
    expect(caught?.backupPath).toBeTruthy()
    expect(path.dirname(caught?.backupPath ?? '')).not.toBe(fixture.userDataDir)
    expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(originalSettings)

    const backupUserData = path.join(caught?.backupPath ?? '', 'userData')
    expect(readFileSync(path.join(backupUserData, SETTINGS_FILE_NAME), 'utf8')).toBe(originalSettings)
    expect(readFileSync(path.join(backupUserData, 'neodeskpet-chat.sqlite3'), 'utf8')).toBe('chat-db')
    expect(readFileSync(path.join(backupUserData, 'chat-attachments', 'image.txt'), 'utf8')).toBe('attachment')
    expect(existsSync(path.join(caught?.backupPath ?? '', 'manifest.json'))).toBe(true)
  })

  it('refuses downgrade before opening the store and leaves a recovery snapshot', () => {
    const fixture = createUserData()
    writeFileSync(
      fixture.settingsPath,
      JSON.stringify({ __internal__: { migrations: { version: '0.22.0' } }, alwaysOnTop: false }),
    )
    const initialize = vi.fn(() => 'not reached')

    expect(() =>
      runProtectedSettingsInitialization({
        userDataDir: fixture.userDataDir,
        targetVersion: '0.21.0',
        now: new Date('2026-07-13T05:00:00.000Z'),
        backupId: 'downgrade',
        initialize,
      }),
    ).toThrow(/Refusing to open settings from newer version/)

    expect(initialize).not.toHaveBeenCalled()
    const backupRoot = path.join(fixture.root, 'neodeskpet-electron-backups')
    expect(existsSync(backupRoot)).toBe(true)
    expect(readFileSync(fixture.settingsPath, 'utf8')).toContain('0.22.0')
  })

  it('does not create a backup for a fresh install', () => {
    const fixture = createUserData()
    const result = runProtectedSettingsInitialization({
      userDataDir: fixture.userDataDir,
      targetVersion: '0.21.0',
      initialize: () => 'created',
    })

    expect(result.value).toBe('created')
    expect(result.assessment.status).toBe('fresh')
    expect(result.backup).toBeNull()
  })
})
