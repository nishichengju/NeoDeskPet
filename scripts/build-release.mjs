import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js')
const requested = new Set(process.argv.slice(2))
const args = [builderCli, '--config', 'electron-builder.config.cjs']

if (requested.has('--win')) args.push('--win')
if (requested.has('--dir')) args.push('--dir')

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    NDP_BUNDLE_BROWSER: requested.has('--full') ? '1' : '0',
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
