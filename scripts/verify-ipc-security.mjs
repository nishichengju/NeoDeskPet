import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const outputDir = path.join(projectRoot, 'artifacts', `ipc-security-smoke-${stamp}`)
const userDataDir = path.join(outputDir, 'userData')
const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const packagedDir = path.join(projectRoot, 'release', packageVersion, 'win-unpacked')
const packagedExeName = existsSync(packagedDir)
  ? readdirSync(packagedDir).find((name) => name.toLowerCase().endsWith('.exe'))
  : undefined
const packagedExe = packagedExeName ? path.join(packagedDir, packagedExeName) : ''
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

mkdirSync(userDataDir, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForApi(page, route) {
  await page.waitForFunction(
    (expectedRoute) => window.location.hash === `#/${expectedRoute}` && Boolean(window.neoDeskPet?.getSettings),
    route,
    { timeout: 30_000 },
  )
}

async function openWindow(app, sourcePage, method, route) {
  const existing = app.windows().find((page) => page.url().endsWith(`#/${route}`))
  if (existing) {
    await waitForApi(existing, route)
    return existing
  }

  const windowPromise = app.waitForEvent('window', { timeout: 30_000 })
  await sourcePage.evaluate((methodName) => window.neoDeskPet[methodName](), method)
  const page = await windowPromise
  await waitForApi(page, route)
  return page
}

async function apiKeys(page) {
  return page.evaluate(() => Object.keys(window.neoDeskPet).sort())
}

const executablePath = packagedExe && existsSync(packagedExe) ? packagedExe : electronExe
const args = packagedExe && existsSync(packagedExe)
  ? [`--user-data-dir=${userDataDir}`]
  : [projectRoot, `--user-data-dir=${userDataDir}`]

let app
try {
  app = await electron.launch({ executablePath, args, timeout: 30_000 })
  const pet = await app.firstWindow({ timeout: 30_000 })
  await waitForApi(pet, 'pet')

  const chat = await openWindow(app, pet, 'openChat', 'chat')
  const settings = await openWindow(app, chat, 'openSettings', 'settings')
  const memory = await openWindow(app, settings, 'openMemory', 'memory')
  let orb = app.windows().find((page) => page.url().endsWith('#/orb'))
  if (!orb) {
    const windowPromise = app.waitForEvent('window', { timeout: 30_000 })
    await pet.evaluate(() => window.neoDeskPet.setDisplayMode('orb'))
    orb = await windowPromise
  }
  await waitForApi(orb, 'orb')

  const keys = {
    pet: await apiKeys(pet),
    chat: await apiKeys(chat),
    settings: await apiKeys(settings),
    memory: await apiKeys(memory),
    orb: await apiKeys(orb),
  }

  const runtimeErrors = {}
  for (const [route, page] of Object.entries({ pet, chat, settings, memory, orb })) {
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApi(page, route)
    await page.waitForTimeout(250)
    runtimeErrors[route] = errors
    assert(errors.length === 0, `${route} emitted runtime errors: ${errors.join(' | ')}`)
  }

  assert(keys.pet.includes('quit'), 'pet is missing its quit capability')
  assert(!keys.pet.includes('setAISettings'), 'pet exposes settings mutation')
  assert(!keys.pet.includes('getChatAttachmentUrl'), 'pet exposes local media access')
  assert(keys.chat.includes('getChatAttachmentUrl'), 'chat is missing local media access')
  assert(!keys.chat.includes('setAISettings'), 'chat exposes AI settings mutation')
  assert(!keys.chat.includes('quit'), 'chat exposes app quit')
  assert(keys.settings.includes('setAISettings'), 'settings is missing AI settings mutation')
  assert(!keys.settings.includes('getChatAttachmentUrl'), 'settings exposes local media access')
  assert(!keys.settings.includes('deleteManyMemory'), 'settings exposes bulk memory deletion')
  assert(keys.memory.includes('deleteManyMemory'), 'memory is missing bulk memory deletion')
  assert(!keys.memory.includes('setAISettings'), 'memory exposes AI settings mutation')
  assert(keys.orb.includes('getChatAttachmentUrl'), 'orb is missing local media access')
  assert(keys.orb.includes('quit'), 'orb is missing app quit')
  assert(!keys.orb.includes('setAISettings'), 'orb exposes AI settings mutation')

  const routeTamper = await chat.evaluate(async () => {
    window.location.hash = '#/settings'
    await new Promise((resolve) => setTimeout(resolve, 50))
    let denied = false
    let error = ''
    try {
      await window.neoDeskPet.getSettings()
    } catch (caught) {
      denied = true
      error = caught instanceof Error ? caught.message : String(caught)
    }
    window.location.hash = '#/chat'
    await new Promise((resolve) => setTimeout(resolve, 50))
    const recovered = Boolean(await window.neoDeskPet.getSettings())
    return { denied, error, recovered }
  })
  assert(routeTamper.denied, 'route-tampered renderer retained IPC access')
  assert(routeTamper.recovered, 'chat IPC did not recover after restoring the trusted route')

  const childWindowDenied = await chat.evaluate(() => {
    const child = window.open('file:///C:/Windows/System32/notepad.exe')
    return child == null || child.closed
  })
  assert(childWindowDenied, 'renderer opened an Electron child window')

  await chat.evaluate(() => {
    window.location.href = 'file:///C:/Windows/System32/notepad.exe'
  })
  await chat.waitForTimeout(150)
  assert(chat.url().endsWith('#/chat'), `untrusted navigation was not blocked: ${chat.url()}`)

  const report = {
    generatedAt: new Date().toISOString(),
    executablePath,
    outputDir,
    urls: {
      pet: pet.url(),
      chat: chat.url(),
      settings: settings.url(),
      memory: memory.url(),
      orb: orb.url(),
    },
    keys,
    runtimeErrors,
    routeTamper,
    childWindowDenied,
  }
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close().catch(() => undefined)
}
