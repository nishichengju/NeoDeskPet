import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

export type Live2dExpressionParam = {
  id: string
  value: number
  blend?: string
}

export type Live2dExpressionInfo = {
  name: string
  file: string
  params: Live2dExpressionParam[]
}

export type Live2dModelMetadata = {
  modelJsonUrl: string
  parameterDisplayNames: Record<string, string>
  expressions: Live2dExpressionInfo[]
  motions: string[]
}

const live2dModelMetadataCache = new Map<string, Live2dModelMetadata>()

function clampText(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '')
  const t = s.trim()
  if (t.length <= maxLen) return t
  return t.slice(0, maxLen)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getLive2dDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'live2d')
  }
  return path.join(app.getAppPath(), 'public', 'live2d')
}

function resolveModelJsonFilePath(modelFileUrl: string): { modelJsonPath: string; modelDir: string } | null {
  const raw = String(modelFileUrl ?? '').trim()
  if (!raw) return null

  const normalized = raw.replace(/\\/g, '/')
  const idx = normalized.indexOf('/live2d/')
  if (idx < 0) return null

  const rel = normalized.slice(idx + '/live2d/'.length).replace(/^\/+/, '')
  if (!rel) return null

  const modelJsonPath = path.join(getLive2dDir(), rel)
  const modelDir = path.dirname(modelJsonPath)
  return { modelJsonPath, modelDir }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const text = fs.readFileSync(filePath, 'utf-8')
    const obj = JSON.parse(text) as unknown
    return isPlainObject(obj) ? obj : null
  } catch {
    return null
  }
}

function parseDisplayInfo(displayInfoPath: string): Record<string, string> {
  const out: Record<string, string> = {}
  const json = safeReadJson(displayInfoPath)
  if (!json) return out

  const paramsRaw = json.Parameters
  const params = Array.isArray(paramsRaw) ? (paramsRaw as unknown[]) : []
  for (const it of params) {
    if (!isPlainObject(it)) continue
    const id = clampText(it.Id, 200)
    const name = clampText(it.Name, 200)
    if (!id || !name) continue
    if (name === '- -') continue
    out[id] = name
  }

  return out
}

function parseExpression(expPath: string): Live2dExpressionParam[] {
  const json = safeReadJson(expPath)
  if (!json) return []
  const paramsRaw = json.Parameters
  const params = Array.isArray(paramsRaw) ? (paramsRaw as unknown[]) : []

  const out: Live2dExpressionParam[] = []
  for (const it of params) {
    if (!isPlainObject(it)) continue
    const id = clampText(it.Id, 200)
    const value = typeof it.Value === 'number' && Number.isFinite(it.Value) ? it.Value : Number.NaN
    if (!id || !Number.isFinite(value)) continue
    const blend = typeof it.Blend === 'string' && it.Blend.trim() ? it.Blend.trim() : undefined
    out.push({ id, value, blend })
    if (out.length >= 60) break
  }
  return out
}

export function readLive2dModelMetadata(modelFileUrl: string): Live2dModelMetadata | null {
  const raw = String(modelFileUrl ?? '').trim()
  if (!raw) return null
  if (live2dModelMetadataCache.has(raw)) return live2dModelMetadataCache.get(raw)!

  const resolved = resolveModelJsonFilePath(raw)
  if (!resolved) return null

  const modelJson = safeReadJson(resolved.modelJsonPath)
  if (!modelJson) return null

  const fileRefs = isPlainObject(modelJson.FileReferences) ? (modelJson.FileReferences as Record<string, unknown>) : {}

  const displayInfoRel = typeof fileRefs.DisplayInfo === 'string' ? fileRefs.DisplayInfo : ''
  const displayInfoPath = displayInfoRel ? path.join(resolved.modelDir, displayInfoRel) : ''
  const parameterDisplayNames = displayInfoPath ? parseDisplayInfo(displayInfoPath) : {}

  const expressionsRaw = fileRefs.Expressions
  const expressionsArr = Array.isArray(expressionsRaw) ? (expressionsRaw as unknown[]) : []
  const expressions: Live2dExpressionInfo[] = []
  for (const it of expressionsArr) {
    if (!isPlainObject(it)) continue
    const name = clampText(it.Name, 120)
    const file = clampText(it.File, 260)
    if (!name || !file) continue
    const filePath = path.join(resolved.modelDir, file)
    const params = parseExpression(filePath)
    expressions.push({ name, file, params })
    if (expressions.length >= 80) break
  }

  const motionsRaw = fileRefs.Motions
  const motions =
    motionsRaw && typeof motionsRaw === 'object' && !Array.isArray(motionsRaw)
      ? Object.keys(motionsRaw as Record<string, unknown>).map((k) => String(k).trim()).filter(Boolean)
      : []

  const meta: Live2dModelMetadata = {
    modelJsonUrl: raw,
    parameterDisplayNames,
    expressions,
    motions: motions.slice(0, 200),
  }

  live2dModelMetadataCache.set(raw, meta)
  return meta
}

