import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const browsersPath = path.join(projectRoot, 'playwright-browsers')
const cliPath = path.join(projectRoot, 'node_modules', 'playwright-core', 'cli.js')

if (!existsSync(cliPath)) {
  console.error(`[Playwright] CLI 不存在：${cliPath}`)
  process.exit(1)
}

mkdirSync(browsersPath, { recursive: true })

const result = spawnSync(process.execPath, [cliPath, 'install', 'chromium-headless-shell'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  },
  stdio: 'inherit',
})

if (result.error) {
  console.error('[Playwright] Chromium 安装失败：', result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
