import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'

// https://vitejs.dev/config/
export default defineConfig({
  optimizeDeps: {
    // 显式限定 dep optimizer 的入口（用绝对路径），避免误扫描项目目录下的其它前端源码（如 Gradio 的 _frontend_code/**/index.html）
    entries: [path.resolve(__dirname, 'index.html'), path.resolve(__dirname, 'demo/orb-motion-lab/index.html')],
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        orbMotionLab: path.resolve(__dirname, 'demo/orb-motion-lab/index.html'),
      },
    },
  },
  server: {
    watch: {
      // GPT-SoVITS 目录体积巨大（包含 python 环境/模型/zip），会显著拖慢 Vite 启动与文件监听初始化
      ignored: [
        '**/GPT-SoVITS-v2_ProPlus/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
      ],
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        // vectorSearchWorker 作为独立 entry 打包成 dist-electron/vectorSearchWorker.js，
        // 供主进程以 worker_threads 启动（见 memoryService.ts）
        entry: {
          main: 'electron/main.ts',
          vectorSearchWorker: 'electron/vectorSearchWorker.ts',
        },
        vite: {
          build: {
            rollupOptions: {
              external: ['better-sqlite3', 'playwright-core'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
    }),
  ],
})
