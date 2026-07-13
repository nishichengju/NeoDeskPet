import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SettingsSecretStore,
  SettingsSecretStoreError,
  hasManagedPlaintextSecrets,
  type SettingsSecretCipher,
} from '../electron/settingsSecretStore'
import { createDefaultSettings } from '../electron/store'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neodeskpet-secrets-'))
  tempDirs.push(directory)
  return directory
}

function createCipher(): SettingsSecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decrypt: (value) => {
      const text = value.toString('utf8')
      if (!text.startsWith('encrypted:')) throw new Error('cipher mismatch')
      return text.slice('encrypted:'.length)
    },
  }
}

describe('settings secret store', () => {
  it('moves managed keys out of settings and restores them in memory', () => {
    const directory = createTempDir()
    const settings = createDefaultSettings()
    settings.ai.apiKey = 'main-key'
    settings.aiProfiles = [
      {
        id: 'profile-1',
        name: 'Profile',
        apiMode: 'openai-compatible',
        apiKey: 'profile-key',
        baseUrl: 'https://example.test/v1',
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    settings.novelai.apiKey = 'novel-key'
    settings.orchestrator.toolAiApiKey = 'tool-key'
    settings.memory.autoExtractAiApiKey = 'extract-key'
    settings.memory.vectorAiApiKey = 'vector-key'
    settings.memory.mmVectorAiApiKey = 'mm-key'
    settings.memory.kgAiApiKey = 'kg-key'

    const store = new SettingsSecretStore(directory, createCipher())
    store.initialize()
    const persisted = store.persist(settings)
    expect(hasManagedPlaintextSecrets(persisted)).toBe(false)

    const rawSecretFile = fs.readFileSync(store.filePath, 'utf8')
    expect(rawSecretFile).not.toContain('main-key')
    expect(rawSecretFile).not.toContain('profile-key')

    const restarted = new SettingsSecretStore(directory, createCipher())
    restarted.initialize()
    const hydrated = restarted.hydrate(persisted)
    expect(hydrated.ai.apiKey).toBe('main-key')
    expect(hydrated.aiProfiles[0]?.apiKey).toBe('profile-key')
    expect(hydrated.novelai.apiKey).toBe('novel-key')
    expect(hydrated.orchestrator.toolAiApiKey).toBe('tool-key')
    expect(hydrated.memory.autoExtractAiApiKey).toBe('extract-key')
    expect(hydrated.memory.vectorAiApiKey).toBe('vector-key')
    expect(hydrated.memory.mmVectorAiApiKey).toBe('mm-key')
    expect(hydrated.memory.kgAiApiKey).toBe('kg-key')
  })

  it('prefers a plaintext migration value over an older encrypted value', () => {
    const directory = createTempDir()
    const initial = createDefaultSettings()
    initial.ai.apiKey = 'old-key'
    const first = new SettingsSecretStore(directory, createCipher())
    first.initialize()
    first.persist(initial)

    const migrated = createDefaultSettings()
    migrated.ai.apiKey = 'new-key'
    const restarted = new SettingsSecretStore(directory, createCipher())
    restarted.initialize()
    const effective = restarted.hydrate(migrated)
    expect(effective.ai.apiKey).toBe('new-key')
    restarted.persist(effective)

    const finalStore = new SettingsSecretStore(directory, createCipher())
    finalStore.initialize()
    expect(finalStore.hydrate(createDefaultSettings()).ai.apiKey).toBe('new-key')
  })

  it('fails without modifying settings when encrypted data cannot be decrypted', () => {
    const directory = createTempDir()
    const filePath = path.join(directory, 'neodeskpet-secrets.json')
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, values: { 'ai.main': Buffer.from('broken').toString('base64') } }))
    const settings = createDefaultSettings()
    settings.ai.apiKey = 'still-plaintext'
    const store = new SettingsSecretStore(directory, createCipher())

    try {
      store.initialize()
      throw new Error('expected decryption to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsSecretStoreError)
      expect(error).toMatchObject({ code: 'decrypt-failed', filePath })
      expect(String(error)).toContain('Unable to decrypt settings secret ai.main')
    }
    expect(settings.ai.apiKey).toBe('still-plaintext')
  })

  it('preserves an unreadable secret file before starting with empty secrets', () => {
    const directory = createTempDir()
    const filePath = path.join(directory, 'neodeskpet-secrets.json')
    fs.writeFileSync(filePath, '{broken-json')
    const store = new SettingsSecretStore(directory, createCipher())
    expect(() => store.initialize()).toThrow('Encrypted settings secret file is invalid')

    const preservedPath = store.preserveUnreadableFile()
    expect(preservedPath).toBeTruthy()
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.readFileSync(preservedPath!, 'utf8')).toBe('{broken-json')

    store.initialize()
    const settings = createDefaultSettings()
    settings.ai.apiKey = 'replacement-key'
    const persisted = store.persist(settings)
    expect(persisted.ai.apiKey).toBe('')
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('replacement-key')
  })

  it('refuses migration when system encryption is unavailable', () => {
    const directory = createTempDir()
    const store = new SettingsSecretStore(directory, {
      isAvailable: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    })
    expect(() => store.initialize()).toThrow('System credential encryption is not available')
  })
})
