/**
 * Live2D Model Configuration
 * Manages available models and their metadata
 * Now uses dynamic scanning from main process
 */

import type { ScannedModel } from '../../electron/types'

export interface Live2DExpression {
  name: string
  file: string
}

export interface Live2DMotion {
  file: string
  sound?: string
  text?: string
}

export interface Live2DMotionGroup {
  name: string
  motions: Live2DMotion[]
}

export interface Live2DModelInfo {
  id: string
  name: string
  path: string
  modelFile: string
  expressions: Live2DExpression[]
  motionGroups: Live2DMotionGroup[]
  hasPhysics: boolean
  hasPose: boolean
}

// Cache for scanned models
let cachedModels: Live2DModelInfo[] | null = null

// Cache for model metadata (expressions, motions)
const modelMetadataCache = new Map<string, Partial<Live2DModelInfo>>()

export const defaultModelJsonUrl = '/live2d/Haru/Haru.model3.json'

/**
 * Convert ScannedModel to Live2DModelInfo
 */
function scannedToModelInfo(scanned: ScannedModel): Live2DModelInfo {
  return {
    id: scanned.id,
    name: scanned.name,
    path: scanned.path,
    modelFile: scanned.modelFile,
    expressions: [],
    motionGroups: [],
    hasPhysics: true,
    hasPose: false,
  }
}

/**
 * Scan and get all available Live2D models
 * Uses IPC to call main process scanner
 */
export async function scanAvailableModels(): Promise<Live2DModelInfo[]> {
  try {
    const api = window.neoDeskPet
    if (!api) {
      return cachedModels || []
    }
    const scannedModels = await api.scanModels()
    cachedModels = scannedModels.map(scannedToModelInfo)
    return cachedModels
  } catch {
    return cachedModels || []
  }
}

/**
 * Get all available Live2D models (cached)
 * Call scanAvailableModels() first to populate the cache
 */
export function getAvailableModels(): Live2DModelInfo[] {
  return cachedModels || []
}

/**
 * Get a model by ID
 */
export function getModelById(id: string): Live2DModelInfo | undefined {
  return cachedModels?.find((m) => m.id === id)
}

/**
 * Get the default model
 */
export function getDefaultModel(): Live2DModelInfo | undefined {
  if (!cachedModels || cachedModels.length === 0) return undefined
  return cachedModels.find((m) => m.id === 'haru') || cachedModels[0]
}

/**
 * Parse model3.json to extract expressions and motions
 */
export async function parseModelMetadata(modelJsonUrl: string): Promise<Partial<Live2DModelInfo>> {
  // Check cache first
  if (modelMetadataCache.has(modelJsonUrl)) {
    return modelMetadataCache.get(modelJsonUrl)!
  }

  try {
    const response = await fetch(modelJsonUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const modelJson = await response.json()
    const metadata: Partial<Live2DModelInfo> = {
      expressions: [],
      motionGroups: [],
      hasPhysics: false,
      hasPose: false,
    }

    // Parse FileReferences
    const fileRefs = modelJson.FileReferences || {}

    // Check for physics and pose
    metadata.hasPhysics = !!fileRefs.Physics
    metadata.hasPose = !!fileRefs.Pose

    // Parse expressions
    if (fileRefs.Expressions && Array.isArray(fileRefs.Expressions)) {
      metadata.expressions = fileRefs.Expressions.map((exp: { Name?: string; File?: string }) => ({
        name: exp.Name || 'Unknown',
        file: exp.File || '',
      }))
    }

    // Parse motions
    if (fileRefs.Motions && typeof fileRefs.Motions === 'object') {
      metadata.motionGroups = Object.entries(fileRefs.Motions).map(([groupName, motions]) => ({
        name: groupName,
        motions: Array.isArray(motions)
          ? motions.map((m: { File?: string; Sound?: string; Text?: string }) => ({
              file: m.File || '',
              sound: m.Sound,
              text: m.Text,
            }))
          : [],
      }))
    }

    // Cache the result
    modelMetadataCache.set(modelJsonUrl, metadata)

    return metadata
  } catch (err) {
    console.warn('[Live2D] Failed to parse model metadata:', err)
    return {
      expressions: [],
      motionGroups: [],
      hasPhysics: false,
      hasPose: false,
    }
  }
}

/**
 * Get full model info with parsed metadata
 */
export async function getModelWithMetadata(id: string): Promise<Live2DModelInfo | null> {
  const model = getModelById(id)
  if (!model) return null

  const metadata = await parseModelMetadata(model.modelFile)
  return {
    ...model,
    ...metadata,
  }
}
