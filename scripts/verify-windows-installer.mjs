import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import * as ResEdit from 'resedit'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const fullEdition = process.argv.includes('--full')
const releaseDir = path.join(projectRoot, 'release', packageJson.version, ...(fullEdition ? ['full'] : []))
const installerPattern = fullEdition
  ? /^NeoDeskPet-.+-Windows-x64-Full-Setup\.exe$/i
  : /^NeoDeskPet-.+-Windows-x64-Setup\.exe$/i
const installerName = readdirSync(releaseDir).find((name) => installerPattern.test(name))
if (!installerName) throw new Error(`NeoDeskPet installer not found in ${releaseDir}`)

const installerPath = path.join(releaseDir, installerName)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const outputDir = path.join(projectRoot, 'artifacts', `windows-${fullEdition ? 'full-' : ''}installer-smoke-${stamp}`)
const installDir = path.join(outputDir, 'installed')
const userDataDir = path.join(outputDir, 'userData')
mkdirSync(outputDir, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} failed with exit ${code ?? 'unknown'}.\n${output}`))
    })
  })
}

function readBranding(executablePath) {
  const executable = ResEdit.NtExecutable.from(readFileSync(executablePath), { ignoreCert: true })
  const resources = ResEdit.NtExecutableResource.from(executable)
  const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0]
  const languages = versionInfo?.getAllLanguagesForStringValues() ?? []
  const strings = languages[0] ? versionInfo.getStringValues(languages[0]) : {}
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  return {
    strings,
    iconGroups: iconGroups.length,
    iconSizes: iconGroups.flatMap((group) => group.icons.map((icon) => {
      // ICO directory entries encode 256 pixels as zero in the one-byte size fields.
      const width = icon.width === 0 ? 256 : icon.width
      const height = icon.height === 0 ? 256 : icon.height
      return `${width}x${height}`
    })),
  }
}

const installedExe = path.join(installDir, 'NeoDeskPet.exe')
let app = null

function findUninstaller() {
  if (!existsSync(installDir)) return null
  const name = readdirSync(installDir).find((entry) => /^Uninstall NeoDeskPet\.exe$/i.test(entry))
  return name ? path.join(installDir, name) : null
}

async function waitForUninstall() {
  const deadline = Date.now() + 15_000
  while (existsSync(installedExe) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!existsSync(installedExe)) {
    // NSIS may keep its temporary cleanup process alive briefly after files disappear.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

async function cleanupInstallation() {
  if (app) {
    try {
      await app.close()
    } catch (error) {
      console.warn(`[Installer smoke] Failed to close Electron during cleanup: ${String(error)}`)
    } finally {
      app = null
    }
  }

  const uninstallerPath = findUninstaller()
  if (!uninstallerPath) return
  try {
    await run(uninstallerPath, ['/S'])
    await waitForUninstall()
  } catch (error) {
    console.warn(`[Installer smoke] Failed to uninstall test application during cleanup: ${String(error)}`)
  }
}

try {
  await run(installerPath, ['/S', `/D=${installDir}`])
  assert(existsSync(installedExe), `installed executable missing: ${installedExe}`)
  const firstBranding = readBranding(installedExe)
  assert(firstBranding.strings.ProductName === 'NeoDeskPet', 'installed executable ProductName is not NeoDeskPet')
  assert(firstBranding.strings.CompanyName === 'nishichengju', 'installed executable CompanyName is not nishichengju')
  assert(firstBranding.iconGroups > 0 && firstBranding.iconSizes.includes('256x256'), 'installed executable icon is missing')

  app = await electron.launch({
    executablePath: installedExe,
    args: [`--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  })
  const firstWindow = await app.firstWindow({ timeout: 30_000 })
  await firstWindow.waitForFunction(() => Boolean(window.neoDeskPet?.getSettings), null, { timeout: 30_000 })
  const title = await firstWindow.title()
  await app.close()
  app = null
  assert(title.includes('NeoDeskPet'), `installed application title is unexpected: ${title}`)

  await run(installerPath, ['/S', `/D=${installDir}`])
  assert(existsSync(installedExe), 'upgrade removed the installed executable')
  const upgradedBranding = readBranding(installedExe)
  assert(upgradedBranding.strings.ProductName === 'NeoDeskPet', 'upgrade lost executable branding')

  const uninstallerPath = findUninstaller()
  assert(uninstallerPath, 'uninstaller was not created')
  await run(uninstallerPath, ['/S'])
  await waitForUninstall()
  assert(!existsSync(installedExe), 'uninstall did not remove the application executable')

  const report = {
    generatedAt: new Date().toISOString(),
    edition: fullEdition ? 'full' : 'compact',
    installerPath,
    installDir,
    applicationTitle: title,
    branding: firstBranding,
    install: true,
    launch: true,
    upgrade: true,
    uninstall: true,
  }
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await cleanupInstallation()
}
