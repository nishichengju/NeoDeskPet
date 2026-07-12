import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const outputDir = path.join(projectRoot, 'artifacts', `local-media-smoke-${stamp}`)
const userDataDir = path.join(outputDir, 'userData')
const managedDir = path.join(userDataDir, 'chat-attachments')
const taskOutputDir = path.join(userDataDir, 'task-output')
const outsideDir = path.join(outputDir, 'outside')
const managedImage = path.join(managedDir, 'managed.png')
const managedVideo = path.join(managedDir, 'managed.mp4')
const outsideImage = path.join(outsideDir, 'outside.png')
const taskImage = path.join(taskOutputDir, 'task.png')
const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const packagedDir = path.join(projectRoot, 'release', packageVersion, 'win-unpacked')
const packagedExeName = existsSync(packagedDir)
  ? readdirSync(packagedDir).find((name) => name.toLowerCase().endsWith('.exe'))
  : undefined
const packagedExe = packagedExeName ? path.join(packagedDir, packagedExeName) : ''
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

mkdirSync(managedDir, { recursive: true })
mkdirSync(taskOutputDir, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
writeFileSync(
  managedImage,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'),
)
writeFileSync(managedVideo, Buffer.from('0123456789'))
writeFileSync(outsideImage, Buffer.from('outside'))
writeFileSync(taskImage, Buffer.from('task-image'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const executablePath = packagedExe && existsSync(packagedExe) ? packagedExe : electronExe
const args = packagedExe && existsSync(packagedExe)
  ? [`--user-data-dir=${userDataDir}`]
  : [projectRoot, `--user-data-dir=${userDataDir}`]

let app
try {
  app = await electron.launch({ executablePath, args, timeout: 30_000 })
  const firstWindow = await app.firstWindow({ timeout: 30_000 })
  await firstWindow.waitForFunction(() => Boolean(window.neoDeskPet), null, { timeout: 30_000 })
  await firstWindow.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'local-media-smoke-file'
    input.type = 'file'
    document.body.appendChild(input)
  })
  await firstWindow.locator('#local-media-smoke-file').setInputFiles(outsideImage)
  const selectedFileResult = await firstWindow.evaluate(async () => {
    const input = document.querySelector('#local-media-smoke-file')
    const file = input?.files?.[0]
    if (!file) throw new Error('Playwright did not populate the selected file')
    return window.neoDeskPet.saveChatAttachmentFile(file, 'image', file.name)
  })

  const ipcResult = await firstWindow.evaluate(
    async ({ imagePath, videoPath, outsidePath }) => {
      const api = window.neoDeskPet
      const image = await api.getChatAttachmentUrl(imagePath)
      const imageById = await api.getChatAttachmentUrl({ resourceId: image.resourceId, path: imagePath })
      const data = await api.readChatAttachmentDataUrl({ resourceId: image.resourceId, path: imagePath })
      const video = await api.getChatAttachmentUrl(videoPath)
      const task = await api.getChatAttachmentUrl('task-output/task.png')

      let outsideRejected = false
      try {
        await api.getChatAttachmentUrl(outsidePath)
      } catch {
        outsideRejected = true
      }

      let forgedSourcePathRejected = false
      try {
        await api.saveChatAttachment({ kind: 'image', sourcePath: outsidePath, filename: 'forged.png' })
      } catch {
        forgedSourcePathRejected = true
      }

      return {
        image,
        imageById,
        dataPrefix: data.dataUrl.slice(0, 32),
        video,
        task,
        outsideRejected,
        forgedSourcePathRejected,
      }
    },
    { imagePath: managedImage, videoPath: managedVideo, outsidePath: outsideImage },
  )

  assert(ipcResult.image.url === ipcResult.imageById.url || ipcResult.image.resourceId === ipcResult.imageById.resourceId, 'resource ID lookup failed')
  assert(ipcResult.dataPrefix.startsWith('data:image/png;base64,'), 'managed image data URL failed')
  assert(ipcResult.outsideRejected, 'outside path was not rejected')
  assert(ipcResult.task.mimeType === 'image/png', 'managed relative task output was not registered')
  assert(ipcResult.forgedSourcePathRejected, 'forged sourcePath was not rejected by preload sanitization')
  assert(selectedFileResult.ok && selectedFileResult.resourceId, 'explicitly selected file was not copied and registered')
  assert(selectedFileResult.path !== outsideImage, 'selected file was served from its original path')
  assert(!ipcResult.video.url.includes('path='), 'media URL still contains a path query')
  assert(!ipcResult.video.url.includes(path.basename(managedVideo)), 'media URL exposes the filename')
  assert(!ipcResult.video.url.includes(Buffer.from(managedVideo).toString('base64')), 'media URL exposes a Base64 path')

  const rangeResponse = await fetch(ipcResult.video.url, { headers: { Range: 'bytes=2-9' } })
  assert(rangeResponse.status === 206, `expected 206 range response, got ${rangeResponse.status}`)
  assert((await rangeResponse.text()) === '23456789', 'video range body mismatch')

  unlinkSync(managedVideo)
  const deletedResponse = await fetch(ipcResult.video.url)
  assert(deletedResponse.status === 404, `deleted media token remained readable (${deletedResponse.status})`)

  const report = {
    generatedAt: new Date().toISOString(),
    executablePath,
    outputDir,
    ipcResult,
    selectedFileResult,
    rangeStatus: rangeResponse.status,
    deletedStatus: deletedResponse.status,
  }
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close().catch(() => undefined)
}
