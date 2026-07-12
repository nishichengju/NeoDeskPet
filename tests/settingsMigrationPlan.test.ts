import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import {
  compareExactSemver,
  selectDeferredMigrationVersions,
  selectPendingMigrationVersions,
} from '../electron/settingsMigrationPlan'

function readDeclaredMigrationVersions(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'electron/store.ts'), 'utf8')
  return [...source.matchAll(/^\s*'(\d+\.\d+\.\d+)':\s*\(store\)/gm)].map((match) => match[1])
}

describe('settings migration planning', () => {
  it('orders exact migration versions numerically', () => {
    expect(['0.10.0', '0.2.0', '1.0.0'].sort(compareExactSemver)).toEqual(['0.2.0', '0.10.0', '1.0.0'])
  })

  it('selects only migrations after the previous version and up to the target', () => {
    const versions = ['0.2.0', '0.3.0', '0.10.0', '0.21.0']
    expect(selectPendingMigrationVersions(versions, '0.3.0', '0.10.0')).toEqual(['0.10.0'])
  })

  it('records migrations currently deferred by the application version', () => {
    const versions = readDeclaredMigrationVersions()
    const deferred = selectDeferredMigrationVersions(versions, packageJson.version)

    expect(versions[0]).toBe('0.2.0')
    expect(versions.at(-1)).toBe('0.21.0')
    expect(selectPendingMigrationVersions(versions, '0.0.0', packageJson.version)).toEqual([])
    expect(deferred).toEqual(versions)
  })
})
