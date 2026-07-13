import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { extractAll } = require('@electron/asar')
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const releaseDir = path.join(projectRoot, 'release', packageJson.version)
const appDir = path.join(releaseDir, 'win-unpacked')
const resourcesDir = path.join(appDir, 'resources')
const asarPath = path.join(resourcesDir, 'app.asar')
const fullReleaseDir = path.join(releaseDir, 'full')
const fullAppDir = path.join(fullReleaseDir, 'win-unpacked')
const fullResourcesDir = path.join(fullAppDir, 'resources')
const analysisRoot = path.join(projectRoot, 'artifacts', 'release-size-analysis')
const extractedAsar = path.join(analysisRoot, 'app-asar')
const jsonPath = path.join(projectRoot, 'artifacts', 'release-size-report.json')
const markdownPath = path.join(projectRoot, 'docs', 'release-size-report-20260713.md')

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function directorySize(target) {
  const info = await stat(target)
  if (info.isFile()) return info.size
  let total = 0
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await directorySize(path.join(target, entry.name))
  }
  return total
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

async function childSizes(target) {
  if (!(await exists(target))) return []
  const rows = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const fullPath = path.join(target, entry.name)
    rows.push({ name: entry.name, bytes: await directorySize(fullPath) })
  }
  return rows.sort((left, right) => right.bytes - left.bytes)
}

if (!(await exists(asarPath))) throw new Error(`Missing packaged app: ${asarPath}`)
await mkdir(analysisRoot, { recursive: true })
await rm(extractedAsar, { recursive: true, force: true })
extractAll(asarPath, extractedAsar)

const installerNames = (await readdir(releaseDir)).filter((name) => name.endsWith('.exe') && name.includes('Setup'))
const installerPath = installerNames.length > 0 ? path.join(releaseDir, installerNames[0]) : null
const fullInstallerNames = (await exists(fullReleaseDir))
  ? (await readdir(fullReleaseDir)).filter((name) => name.endsWith('.exe') && name.includes('Full-Setup'))
  : []
const fullInstallerPath = fullInstallerNames.length > 0 ? path.join(fullReleaseDir, fullInstallerNames[0]) : null
const fullTotals = (await exists(fullAppDir))
  ? {
      unpackedBytes: await directorySize(fullAppDir),
      appAsarBytes: (await stat(path.join(fullResourcesDir, 'app.asar'))).size,
      bundledBrowserBytes: (await exists(path.join(fullResourcesDir, 'playwright-browsers')))
        ? await directorySize(path.join(fullResourcesDir, 'playwright-browsers'))
        : 0,
      installerBytes: fullInstallerPath ? (await stat(fullInstallerPath)).size : 0,
    }
  : null
const report = {
  generatedAt: new Date().toISOString(),
  version: packageJson.version,
  strategy: (await exists(path.join(resourcesDir, 'playwright-browsers'))) ? 'full' : 'compact',
  totals: {
    unpackedBytes: await directorySize(appDir),
    appAsarBytes: (await stat(asarPath)).size,
    appAsarUnpackedBytes: (await exists(path.join(resourcesDir, 'app.asar.unpacked')))
      ? await directorySize(path.join(resourcesDir, 'app.asar.unpacked'))
      : 0,
    bundledBrowserBytes: (await exists(path.join(resourcesDir, 'playwright-browsers')))
      ? await directorySize(path.join(resourcesDir, 'playwright-browsers'))
      : 0,
    installerBytes: installerPath ? (await stat(installerPath)).size : 0,
  },
  fullTotals,
  resources: await childSizes(resourcesDir),
  asarRoots: await childSizes(extractedAsar),
  productionDependencies: (await childSizes(path.join(extractedAsar, 'node_modules'))).slice(0, 30),
  packagedModels: await childSizes(path.join(extractedAsar, 'dist', 'live2d')),
}

await mkdir(path.dirname(jsonPath), { recursive: true })
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const topDependencies = report.productionDependencies
  .slice(0, 12)
  .map((row) => `| \`${row.name}\` | ${mib(row.bytes)} MiB |`)
  .join('\n')
const modelRows = report.packagedModels
  .map((row) => `| ${row.name} | ${mib(row.bytes)} MiB |`)
  .join('\n')
const browserNote = report.totals.bundledBrowserBytes > 0
  ? `完整版内置浏览器资源 ${mib(report.totals.bundledBrowserBytes)} MiB。`
  : '精简版不内置浏览器；首次使用无头浏览器工具时下载到用户数据目录。'
const compactInstallerReduction = report.totals.installerBytes > 0
  ? Math.round((1 - report.totals.installerBytes / (263.6 * 1024 * 1024)) * 100)
  : 0
const asarReduction = Math.round((1 - report.totals.appAsarBytes / (343.88 * 1024 * 1024)) * 100)
const fullRows = report.fullTotals
  ? `- 完整版 unpacked：${mib(report.fullTotals.unpackedBytes)} MiB
- 完整版 app.asar：${mib(report.fullTotals.appAsarBytes)} MiB
- 完整版内置浏览器：${mib(report.fullTotals.bundledBrowserBytes)} MiB
- 完整版安装器：${report.fullTotals.installerBytes > 0 ? `${mib(report.fullTotals.installerBytes)} MiB` : '尚未生成'}`
  : '- 完整版：尚未构建'

const markdown = `# NeoDeskPet 发布体积报告

- 生成时间：${report.generatedAt}
- 版本：${report.version}
- 构建策略：${report.strategy === 'full' ? '完整版' : '精简版'}
- 基线：旧 unpacked 目录约 870.91 MiB，旧 app.asar 343.88 MiB，随包浏览器 273.07 MiB。
- 当前 unpacked：${mib(report.totals.unpackedBytes)} MiB
- 当前 app.asar：${mib(report.totals.appAsarBytes)} MiB
- 当前 app.asar.unpacked：${mib(report.totals.appAsarUnpackedBytes)} MiB
- 当前安装器：${report.totals.installerBytes > 0 ? `${mib(report.totals.installerBytes)} MiB` : '尚未生成'}
- 精简安装器相对旧基线缩小：${compactInstallerReduction}%
- app.asar 相对旧基线缩小：${asarReduction}%

${fullRows}

${browserNote}

## 打包策略

1. 默认精简包只包含生产依赖、七个仓库内示例 Live2D 模型和运行时代码。
2. 本地被忽略的第三方模型不会进入正式包，避免把开发机器私有资源带入发布产物。
3. Playwright Core 保留在应用中；精简包首次使用时自动安装匹配的 Chromium Headless Shell 到用户数据目录。
4. 设置 \`NDP_BUNDLE_BROWSER=1\`（\`npm run build:full\`）可生成离线完整版。
5. \`better-sqlite3\` 与 \`playwright-core\` 显式放入 \`app.asar.unpacked\`，保证 native addon、驱动和安装 CLI 可直接访问。

## 最大生产依赖

| 依赖 | 体积 |
| --- | ---: |
${topDependencies}

## 随包 Live2D 示例

| 模型 | 体积 |
| --- | ---: |
${modelRows}
`

await writeFile(markdownPath, markdown, 'utf8')
console.log(`[Release size] ${report.strategy} unpacked=${mib(report.totals.unpackedBytes)} MiB asar=${mib(report.totals.appAsarBytes)} MiB`)
