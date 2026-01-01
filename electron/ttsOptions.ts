import fs from 'node:fs'
import path from 'node:path'

export type TtsModelOption = {
  label: string
  weightsPath: string
}

export type TtsRefAudioOption = {
  label: string
  value: string
  fileName: string
  promptText: string
}

export type TtsOptions = {
  gptModels: TtsModelOption[]
  sovitsModels: TtsModelOption[]
  refAudios: TtsRefAudioOption[]
  ttsRoot: string
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function listFilesByExt(dir: string, exts: string[]): string[] {
  const lowered = exts.map((e) => e.toLowerCase())
  return safeReadDir(dir).filter((f) => lowered.some((ext) => f.toLowerCase().endsWith(ext)))
}

function parseRefAudioFileName(fileName: string): { speaker: string; promptText: string } {
  const base = path.parse(fileName).name.trim()
  const m = base.match(/^\[([^\]]+)\](.+)$/)
  if (!m) return { speaker: base || fileName, promptText: base || fileName }
  const speaker = (m[1] || '').trim() || base
  const promptText = (m[2] || '').trim() || base
  return { speaker, promptText }
}

function dedupeLabels<T extends { label: string }>(items: T[]): T[] {
  const counts = new Map<string, number>()
  const next = items.map((it) => {
    const c = (counts.get(it.label) ?? 0) + 1
    counts.set(it.label, c)
    return { ...it, label: c === 1 ? it.label : `${it.label} (${c})` }
  })
  return next
}

export function listTtsOptions(appRoot: string): TtsOptions {
  const ttsRoot = path.join(appRoot, 'GPT-SoVITS-v2_ProPlus')

  const gptModels: TtsModelOption[] = []
  const sovitsModels: TtsModelOption[] = []
  const refAudios: TtsRefAudioOption[] = []

  const pretrainedDir = path.join(ttsRoot, 'GPT_SoVITS', 'pretrained_models')
  const v2ProDir = path.join(pretrainedDir, 'v2Pro')
  const gptWeightsDir = path.join(ttsRoot, 'GPT_weights_v2')
  const sovitsWeightsDir = path.join(ttsRoot, 'SoVITS_weights_v2')
  const refAudioDir = path.join(ttsRoot, '参考音频')

  if (fs.existsSync(pretrainedDir)) {
    const gptBase = path.join(pretrainedDir, 's1v3.ckpt')
    if (fs.existsSync(gptBase)) {
      gptModels.push({ label: '不训练直接推v3底模！', weightsPath: 'GPT_SoVITS/pretrained_models/s1v3.ckpt' })
    }

    const v2ProPlus = path.join(v2ProDir, 's2Gv2ProPlus.pth')
    if (fs.existsSync(v2ProPlus)) {
      sovitsModels.push({
        label: '不训练直接推v2ProPlus底模！',
        weightsPath: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth',
      })
    }

    const v2Pro = path.join(v2ProDir, 's2Gv2Pro.pth')
    if (fs.existsSync(v2Pro)) {
      sovitsModels.push({
        label: '不训练直接推v2Pro底模！',
        weightsPath: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth',
      })
    }

    const v3 = path.join(pretrainedDir, 's2Gv3.pth')
    if (fs.existsSync(v3)) {
      sovitsModels.push({ label: '不训练直接推v3底模！', weightsPath: 'GPT_SoVITS/pretrained_models/s2Gv3.pth' })
    }
  }

  for (const file of listFilesByExt(gptWeightsDir, ['.ckpt'])) {
    gptModels.push({
      label: path.parse(file).name,
      weightsPath: `GPT_weights_v2/${file}`,
    })
  }

  for (const file of listFilesByExt(sovitsWeightsDir, ['.pth'])) {
    sovitsModels.push({
      label: path.parse(file).name,
      weightsPath: `SoVITS_weights_v2/${file}`,
    })
  }

  for (const file of listFilesByExt(refAudioDir, ['.wav'])) {
    const parsed = parseRefAudioFileName(file)
    refAudios.push({
      label: parsed.speaker,
      value: `参考音频/${file}`,
      fileName: file,
      promptText: parsed.promptText,
    })
  }

  return {
    gptModels: dedupeLabels(gptModels),
    sovitsModels: dedupeLabels(sovitsModels),
    refAudios: dedupeLabels(refAudios),
    ttsRoot,
  }
}

