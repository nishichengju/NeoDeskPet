import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(projectRoot, 'public', 'brand', 'neodeskpet-icon.svg')
const outputDir = path.join(projectRoot, 'build')
const browsersPath = path.join(projectRoot, 'playwright-browsers')
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const icoSizes = [16, 24, 32, 48, 64, 128, 256]

process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath

function createIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(images.length * 16)
  let offset = header.length + directory.length
  images.forEach(({ size, data }, index) => {
    const entry = index * 16
    directory.writeUInt8(size >= 256 ? 0 : size, entry)
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

await mkdir(outputDir, { recursive: true })
const svg = await readFile(sourcePath, 'utf8')
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ headless: true })

try {
  for (const size of pngSizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path: path.join(outputDir, `icon-${size}.png`), omitBackground: true })
    await page.close()
  }
} finally {
  await browser.close()
}

const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({ size, data: await readFile(path.join(outputDir, `icon-${size}.png`)) })),
)
await writeFile(path.join(outputDir, 'icon.ico'), createIco(icoImages))
await copyFile(path.join(outputDir, 'icon-512.png'), path.join(outputDir, 'icon.png'))

console.log(`[Brand] generated ${pngSizes.length} PNG assets and build/icon.ico`)
