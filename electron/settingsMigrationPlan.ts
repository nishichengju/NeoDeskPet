export type ExactSemver = `${number}.${number}.${number}`

function parseExactSemver(version: string): [number, number, number] {
  const match = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`Invalid exact semver: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareExactSemver(left: string, right: string): number {
  const a = parseExactSemver(left)
  const b = parseExactSemver(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function selectPendingMigrationVersions(
  knownVersions: readonly string[],
  previousVersion: string,
  targetVersion: string,
): string[] {
  return [...knownVersions]
    .sort(compareExactSemver)
    .filter(
      (candidate) =>
        compareExactSemver(candidate, previousVersion) > 0 && compareExactSemver(candidate, targetVersion) <= 0,
    )
}

export function selectDeferredMigrationVersions(knownVersions: readonly string[], targetVersion: string): string[] {
  return [...knownVersions].sort(compareExactSemver).filter((candidate) => compareExactSemver(candidate, targetVersion) > 0)
}
