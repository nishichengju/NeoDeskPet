import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import {
  SETTINGS_MIGRATION_VERSIONS,
  applySettingsMigrations,
  normalizeSettings,
} from '../electron/store'
import { compareExactSemver } from '../electron/settingsMigrationPlan'

describe('settings migrations', () => {
  it('creates a complete current configuration for a fresh install', () => {
    const result = applySettingsMigrations({
      value: {},
      previousVersion: '0.0.0',
      targetVersion: packageJson.version,
    })
    const settings = normalizeSettings(result.settings)

    expect(result.appliedVersions).toEqual(SETTINGS_MIGRATION_VERSIONS)
    expect(result.settings.__internal__.migrations.version).toBe(packageJson.version)
    expect(settings.ai.baseUrl).toBe('https://api.openai.com/v1')
    expect(settings.bubble.showOnClick).toBe(true)
    expect(settings.memory.enabled).toBe(true)
    expect(settings.tts.playbackTextMode).toBe('full')
    expect(settings.asr.wsUrl).toBe('ws://127.0.0.1:8000/demo/ws/realtime')
  })

  it('upgrades a 0.1.0-era configuration once while preserving user values', () => {
    const firstResult = applySettingsMigrations({
      previousVersion: '0.0.0',
      targetVersion: packageJson.version,
      value: {
        alwaysOnTop: false,
        petScale: 9,
        bubble: {
          position: 'bottom-left',
          showOnClick: false,
          clickPhrases: [],
        },
        ai: {
          provider: 'openai',
          openaiApiKey: 'legacy-key',
          openaiBaseUrl: 'https://legacy.example/v1',
          openaiModel: 'legacy-model',
          temperature: 0,
          maxTokens: 1234,
          maxContextTokens: 5678,
          systemPrompt: '',
          enableVision: true,
          enableChatStreaming: true,
        },
      },
    })
    const migrated = normalizeSettings(firstResult.settings)

    expect(firstResult.appliedVersions).toEqual(SETTINGS_MIGRATION_VERSIONS)
    expect(migrated.alwaysOnTop).toBe(false)
    expect(migrated.petScale).toBe(1)
    expect(migrated.bubble).toMatchObject({
      positionX: 5,
      positionY: 70,
      tailDirection: 'up',
      showOnClick: false,
    })
    expect(migrated.ai).toMatchObject({
      apiKey: 'legacy-key',
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      temperature: 0,
      maxTokens: 1234,
      maxContextTokens: 5678,
      systemPrompt: '',
      enableVision: true,
      enableChatStreaming: true,
    })

    const secondResult = applySettingsMigrations({
      value: firstResult.settings as unknown as Record<string, unknown>,
      previousVersion: packageJson.version,
      targetVersion: packageJson.version,
    })
    expect(secondResult.appliedVersions).toEqual([])
    expect(secondResult.settings).toEqual(firstResult.settings)
  })

  it.each(['0.5.0', '0.12.0', '0.19.0', '0.20.0'])(
    'runs only migrations newer than %s',
    (previousVersion) => {
      const result = applySettingsMigrations({
        previousVersion,
        targetVersion: packageJson.version,
        value: {
          __internal__: { migrations: { version: previousVersion } },
          alwaysOnTop: false,
          ai: { thinkingEffort: 'medium' },
          tts: { enabled: true },
        },
      })
      const expected = SETTINGS_MIGRATION_VERSIONS.filter(
        (version) => compareExactSemver(version, previousVersion) > 0,
      )

      expect(result.appliedVersions).toEqual(expected)
      expect(normalizeSettings(result.settings).alwaysOnTop).toBe(false)
      expect(result.settings.__internal__.migrations.version).toBe(packageJson.version)
    },
  )
})
