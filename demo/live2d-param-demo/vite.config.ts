import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

export default defineConfig({
  server: {
    port: 5177,
    strictPort: false,
  },
  plugins: [
    {
      name: 'ndp-live2d-model-index',
      configureServer(server) {
        const envDir = String(process.env.NDP_LIVE2D_DIR ?? '').trim()
        const baseDir = envDir ? path.resolve(envDir) : path.resolve(__dirname, 'public', 'live2d')

        const contentTypeByExt = (ext: string) => {
          const e = ext.toLowerCase()
          if (e === '.json' || e === '.model3.json' || e === '.model.json' || e === '.cdi3.json') return 'application/json; charset=utf-8'
          if (e === '.moc3' || e === '.moc') return 'application/octet-stream'
          if (e === '.png') return 'image/png'
          if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
          if (e === '.webp') return 'image/webp'
          if (e === '.gif') return 'image/gif'
          if (e === '.mp3') return 'audio/mpeg'
          if (e === '.wav') return 'audio/wav'
          return 'application/octet-stream'
        }

        const scanModels = () => {
          const out: Array<{ id: string; name: string; url: string; file: string; dir: string }> = []
          try {
            if (!fs.existsSync(baseDir)) return out

            const entries = fs.readdirSync(baseDir, { withFileTypes: true })
            for (const ent of entries) {
              if (!ent.isDirectory()) continue
              const dirName = ent.name
              const folderPath = path.join(baseDir, dirName)
              const files = fs.readdirSync(folderPath)
              const model3 = files.find((f) => f.endsWith('.model3.json'))
              const model2 = files.find((f) => f.endsWith('.model.json'))
              const picked = model3 ?? model2
              if (!picked) continue

              const id = dirName.toLowerCase().replace(/[^a-z0-9]/g, '_')
              const url = envDir ? `/__ndp_live2d/${encodeURIComponent(dirName)}/${encodeURIComponent(picked)}` : `/live2d/${encodeURIComponent(dirName)}/${encodeURIComponent(picked)}`
              out.push({ id, name: dirName, url, file: picked, dir: dirName })
            }
          } catch {
            // ignore
          }

          out.sort((a, b) => a.name.localeCompare(b.name))
          return out
        }

        // 列表接口：前端拉取模型清单
        server.middlewares.use('/__ndp_live2d/models', (_req, res) => {
          const models = scanModels()
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ baseDir, models }, null, 2))
        })

        // 外部目录资源代理（仅当 NDP_LIVE2D_DIR 指向外部目录时启用）
        server.middlewares.use('/__ndp_live2d/', (req, res, next) => {
          if (!envDir) return next()
          const url = new URL(req.url ?? '/', 'http://local')
          const rel = decodeURIComponent(url.pathname.replace(/^\/__ndp_live2d\/+/, ''))
          const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
          if (!normalized) return next()

          const abs = path.join(baseDir, normalized)
          if (!abs.startsWith(baseDir)) return next()
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return next()

          res.statusCode = 200
          res.setHeader('Content-Type', contentTypeByExt(path.extname(abs)))
          fs.createReadStream(abs).pipe(res)
        })
      },
    },
  ],
})

