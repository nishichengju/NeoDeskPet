/**
 * Live2D Model Scanner
 * Scans the live2d directory for available models
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { ScannedModel } from './types'

/**
 * Get the live2d directory path
 * In development: public/live2d
 * In production: resources/app.asar.unpacked/dist/live2d or similar
 */
function getLive2dDir(): string {
  if (app.isPackaged) {
    // Production: look in the app resources
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'live2d')
  } else {
    // Development: look in public folder
    return path.join(app.getAppPath(), 'public', 'live2d')
  }
}

/**
 * Find model file in a directory
 * Looks for .model3.json or .model.json files
 */
function findModelFile(dirPath: string): string | null {
  try {
    const files = fs.readdirSync(dirPath)

    // First try to find .model3.json (Live2D Cubism 3+)
    const model3File = files.find(f => f.endsWith('.model3.json'))
    if (model3File) {
      return model3File
    }

    // Then try .model.json (Live2D Cubism 2)
    const modelFile = files.find(f => f.endsWith('.model.json'))
    if (modelFile) {
      return modelFile
    }

    return null
  } catch {
    return null
  }
}

/**
 * Scan the live2d directory for available models
 */
export function scanLive2dModels(): ScannedModel[] {
  const live2dDir = getLive2dDir()
  const models: ScannedModel[] = []

  try {
    if (!fs.existsSync(live2dDir)) {
      return models
    }

    const entries = fs.readdirSync(live2dDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const folderName = entry.name
      const folderPath = path.join(live2dDir, folderName)
      const modelFileName = findModelFile(folderPath)

      if (modelFileName) {
        const model: ScannedModel = {
          id: folderName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          name: folderName,
          path: `/live2d/${folderName}`,
          modelFile: `/live2d/${folderName}/${modelFileName}`,
        }

        models.push(model)
      }
    }
  } catch {
    // Silently fail
  }

  models.sort((a, b) => a.name.localeCompare(b.name))

  return models
}
