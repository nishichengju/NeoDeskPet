import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings } from './types'
import type { SettingsSecretAdapter } from './store'

const SECRET_FILE_NAME = 'neodeskpet-secrets.json'
const SECRET_FILE_VERSION = 1

export type SettingsSecretStoreErrorCode =
  | 'encryption-unavailable'
  | 'invalid-file'
  | 'decrypt-failed'

export class SettingsSecretStoreError extends Error {
  readonly code: SettingsSecretStoreErrorCode
  readonly filePath: string

  constructor(code: SettingsSecretStoreErrorCode, filePath: string, message: string) {
    super(message)
    this.name = 'SettingsSecretStoreError'
    this.code = code
    this.filePath = filePath
  }
}

export type SettingsSecretCipher = {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

type StoredSecretFile = {
  version: number
  values: Record<string, string>
}

function profileSecretKey(profileId: string): string {
  return `ai.profile.${profileId}`
}

function normalizedSecret(value: unknown): string {
  return String(value ?? '').trim()
}

function mapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

export function hasManagedPlaintextSecrets(settings: AppSettings): boolean {
  return Boolean(
    normalizedSecret(settings.ai.apiKey) ||
      settings.aiProfiles.some((profile) => normalizedSecret(profile.apiKey)) ||
      normalizedSecret(settings.novelai.apiKey) ||
      normalizedSecret(settings.orchestrator.toolAiApiKey) ||
      normalizedSecret(settings.memory.autoExtractAiApiKey) ||
      normalizedSecret(settings.memory.vectorAiApiKey) ||
      normalizedSecret(settings.memory.mmVectorAiApiKey) ||
      normalizedSecret(settings.memory.kgAiApiKey),
  )
}

export class SettingsSecretStore implements SettingsSecretAdapter {
  readonly filePath: string
  private readonly cipher: SettingsSecretCipher
  private values = new Map<string, string>()

  constructor(userDataDir: string, cipher: SettingsSecretCipher) {
    this.filePath = path.join(path.resolve(userDataDir), SECRET_FILE_NAME)
    this.cipher = cipher
  }

  initialize(): void {
    if (!this.cipher.isAvailable()) {
      throw new SettingsSecretStoreError(
        'encryption-unavailable',
        this.filePath,
        'System credential encryption is not available',
      )
    }
    if (!existsSync(this.filePath)) return

    let stored: StoredSecretFile
    try {
      stored = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredSecretFile
    } catch (error) {
      throw new SettingsSecretStoreError(
        'invalid-file',
        this.filePath,
        `Encrypted settings secret file is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (stored.version !== SECRET_FILE_VERSION || !stored.values || typeof stored.values !== 'object') {
      throw new SettingsSecretStoreError(
        'invalid-file',
        this.filePath,
        `Unsupported encrypted settings secret version: ${String(stored.version)}`,
      )
    }

    const decrypted = new Map<string, string>()
    for (const [key, encoded] of Object.entries(stored.values)) {
      try {
        const value = this.cipher.decrypt(Buffer.from(String(encoded), 'base64'))
        if (value) decrypted.set(key, value)
      } catch (error) {
        throw new SettingsSecretStoreError(
          'decrypt-failed',
          this.filePath,
          `Unable to decrypt settings secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.values = decrypted
  }

  preserveUnreadableFile(): string | null {
    if (!existsSync(this.filePath)) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    const preservedPath = `${this.filePath}.unreadable-${stamp}.bak`
    renameSync(this.filePath, preservedPath)
    this.values = new Map()
    return preservedPath
  }

  hydrate(settings: AppSettings): AppSettings {
    const hydrated = structuredClone(settings)
    hydrated.ai.apiKey = normalizedSecret(hydrated.ai.apiKey) || this.values.get('ai.main') || ''
    hydrated.aiProfiles = hydrated.aiProfiles.map((profile) => ({
      ...profile,
      apiKey: normalizedSecret(profile.apiKey) || this.values.get(profileSecretKey(profile.id)) || '',
    }))
    hydrated.novelai.apiKey = normalizedSecret(hydrated.novelai.apiKey) || this.values.get('novelai') || ''
    hydrated.orchestrator.toolAiApiKey =
      normalizedSecret(hydrated.orchestrator.toolAiApiKey) || this.values.get('orchestrator.tool') || ''
    hydrated.memory.autoExtractAiApiKey =
      normalizedSecret(hydrated.memory.autoExtractAiApiKey) || this.values.get('memory.autoExtract') || ''
    hydrated.memory.vectorAiApiKey =
      normalizedSecret(hydrated.memory.vectorAiApiKey) || this.values.get('memory.vector') || ''
    hydrated.memory.mmVectorAiApiKey =
      normalizedSecret(hydrated.memory.mmVectorAiApiKey) || this.values.get('memory.mmVector') || ''
    hydrated.memory.kgAiApiKey = normalizedSecret(hydrated.memory.kgAiApiKey) || this.values.get('memory.kg') || ''
    return hydrated
  }

  persist(settings: AppSettings): AppSettings {
    const nextValues = new Map<string, string>()
    const add = (key: string, value: unknown) => {
      const normalized = normalizedSecret(value)
      if (normalized) nextValues.set(key, normalized)
    }

    add('ai.main', settings.ai.apiKey)
    for (const profile of settings.aiProfiles) add(profileSecretKey(profile.id), profile.apiKey)
    add('novelai', settings.novelai.apiKey)
    add('orchestrator.tool', settings.orchestrator.toolAiApiKey)
    add('memory.autoExtract', settings.memory.autoExtractAiApiKey)
    add('memory.vector', settings.memory.vectorAiApiKey)
    add('memory.mmVector', settings.memory.mmVectorAiApiKey)
    add('memory.kg', settings.memory.kgAiApiKey)

    if (!mapsEqual(this.values, nextValues) || (!existsSync(this.filePath) && nextValues.size > 0)) {
      this.writeValues(nextValues)
      this.values = nextValues
    }

    const persisted = structuredClone(settings)
    persisted.ai.apiKey = ''
    delete persisted.ai.hasApiKey
    persisted.aiProfiles = persisted.aiProfiles.map((profile) => {
      const next = { ...profile, apiKey: '' }
      delete next.hasApiKey
      return next
    })
    persisted.novelai.apiKey = ''
    delete persisted.novelai.hasApiKey
    persisted.orchestrator.toolAiApiKey = ''
    delete persisted.orchestrator.hasToolAiApiKey
    persisted.memory.autoExtractAiApiKey = ''
    delete persisted.memory.hasAutoExtractAiApiKey
    persisted.memory.vectorAiApiKey = ''
    delete persisted.memory.hasVectorAiApiKey
    persisted.memory.mmVectorAiApiKey = ''
    delete persisted.memory.hasMmVectorAiApiKey
    persisted.memory.kgAiApiKey = ''
    delete persisted.memory.hasKgAiApiKey
    return persisted
  }

  private writeValues(values: Map<string, string>): void {
    const encoded: Record<string, string> = {}
    for (const [key, value] of values) encoded[key] = this.cipher.encrypt(value).toString('base64')

    const directory = path.dirname(this.filePath)
    mkdirSync(directory, { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(
      tempPath,
      `${JSON.stringify({ version: SECRET_FILE_VERSION, values: encoded }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    renameSync(tempPath, this.filePath)
  }
}
