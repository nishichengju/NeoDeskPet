import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { compareExactSemver } from './settingsMigrationPlan'

export const SETTINGS_FILE_NAME = 'neodeskpet-settings.json'

export type SettingsMigrationAssessment =
  | { status: 'fresh'; previousVersion: null; targetVersion: string }
  | { status: 'current'; previousVersion: string; targetVersion: string }
  | { status: 'migrate'; previousVersion: string; targetVersion: string }
  | { status: 'downgrade'; previousVersion: string; targetVersion: string }
  | { status: 'invalid'; previousVersion: null; targetVersion: string; error: string }

export type UserDataBackup = {
  directory: string
  userDataPath: string
  settingsPath: string | null
}

export type ProtectedSettingsInitialization<T> = {
  value: T
  assessment: SettingsMigrationAssessment
  backup: UserDataBackup | null
}

type StoredSettingsMetadata = {
  __internal__?: {
    migrations?: {
      version?: unknown
    }
  }
}

function formatBackupTimestamp(value: Date): string {
  const pad = (part: number, size = 2) => String(part).padStart(size, '0')
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    '-',
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
    '-',
    pad(value.getMilliseconds(), 3),
  ].join('')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function assessSettingsMigration(settingsPath: string, targetVersion: string): SettingsMigrationAssessment {
  compareExactSemver(targetVersion, targetVersion)
  if (!existsSync(settingsPath)) return { status: 'fresh', previousVersion: null, targetVersion }

  try {
    const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as StoredSettingsMetadata | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError('Settings root must be a JSON object')
    }

    const storedVersion = parsed.__internal__?.migrations?.version
    const previousVersion = storedVersion === undefined ? '0.0.0' : String(storedVersion).trim()
    compareExactSemver(previousVersion, previousVersion)
    const comparison = compareExactSemver(previousVersion, targetVersion)
    if (comparison === 0) return { status: 'current', previousVersion, targetVersion }
    if (comparison > 0) return { status: 'downgrade', previousVersion, targetVersion }
    return { status: 'migrate', previousVersion, targetVersion }
  } catch (error) {
    return {
      status: 'invalid',
      previousVersion: null,
      targetVersion,
      error: describeError(error),
    }
  }
}

export function createUserDataBackup(
  userDataDir: string,
  assessment: SettingsMigrationAssessment,
  options: { now?: Date; id?: string } = {},
): UserDataBackup {
  const source = path.resolve(userDataDir)
  if (!existsSync(source)) throw new Error(`User data directory does not exist: ${source}`)

  const backupRoot = path.join(path.dirname(source), `${path.basename(source)}-backups`)
  mkdirSync(backupRoot, { recursive: true })

  const now = options.now ?? new Date()
  const timestamp = formatBackupTimestamp(now)
  const id = String(options.id ?? randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '') || 'snapshot'
  const snapshotName = `${timestamp}-settings-${assessment.status}-${id}`
  const partialDirectory = path.join(backupRoot, `.${snapshotName}.partial`)
  const finalDirectory = path.join(backupRoot, snapshotName)
  const copiedUserDataPath = path.join(partialDirectory, 'userData')

  mkdirSync(partialDirectory, { recursive: false })
  cpSync(source, copiedUserDataPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  })
  writeFileSync(
    path.join(partialDirectory, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: now.toISOString(),
        source,
        reason: assessment.status,
        previousVersion: assessment.previousVersion,
        targetVersion: assessment.targetVersion,
      },
      null,
      2,
    ),
    'utf8',
  )
  renameSync(partialDirectory, finalDirectory)

  const settingsPath = path.join(finalDirectory, 'userData', SETTINGS_FILE_NAME)
  return {
    directory: finalDirectory,
    userDataPath: path.join(finalDirectory, 'userData'),
    settingsPath: existsSync(settingsPath) ? settingsPath : null,
  }
}

export class SettingsMigrationProtectionError extends Error {
  readonly backupPath: string | null
  readonly originalError: unknown

  constructor(message: string, backupPath: string | null, originalError?: unknown) {
    super(message)
    this.name = 'SettingsMigrationProtectionError'
    this.backupPath = backupPath
    this.originalError = originalError
  }
}

export function runProtectedSettingsInitialization<T>(options: {
  userDataDir: string
  targetVersion: string
  initialize: (assessment: SettingsMigrationAssessment) => T
  now?: Date
  backupId?: string
}): ProtectedSettingsInitialization<T> {
  const settingsPath = path.join(path.resolve(options.userDataDir), SETTINGS_FILE_NAME)
  const assessment = assessSettingsMigration(settingsPath, options.targetVersion)
  let backup: UserDataBackup | null = null

  if (assessment.status === 'migrate' || assessment.status === 'invalid' || assessment.status === 'downgrade') {
    backup = createUserDataBackup(options.userDataDir, assessment, {
      now: options.now,
      id: options.backupId,
    })
  }

  if (assessment.status === 'downgrade') {
    throw new SettingsMigrationProtectionError(
      `Refusing to open settings from newer version ${assessment.previousVersion} with ${assessment.targetVersion}`,
      backup?.directory ?? null,
    )
  }

  try {
    return {
      value: options.initialize(assessment),
      assessment,
      backup,
    }
  } catch (error) {
    let restoreError: unknown = null
    if (backup?.settingsPath) {
      try {
        copyFileSync(backup.settingsPath, settingsPath)
      } catch (caught) {
        restoreError = caught
      }
    }

    const restoreSuffix = restoreError ? ` Settings restore also failed: ${describeError(restoreError)}.` : ''
    throw new SettingsMigrationProtectionError(
      `Settings initialization failed: ${describeError(error)}.${restoreSuffix}`,
      backup?.directory ?? null,
      error,
    )
  }
}
