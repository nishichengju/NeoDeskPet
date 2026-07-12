import { defaultUrlTransform } from 'react-markdown'

export function applyMarkdownLocalImagePathCompat(input: string): string {
  const text = String(input ?? '')
  if (!text.includes('![')) return text

  return text.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (_match, prefix: string, rawPath: string, suffix: string) => {
    const destination = String(rawPath ?? '').trim()
    if (!destination) return `${prefix}${rawPath}${suffix}`
    if (/^(https?:|data:|blob:|file:)/i.test(destination)) return `${prefix}${destination}${suffix}`

    if (/^[a-zA-Z]:\\/.test(destination) || /^\\\\/.test(destination)) {
      const normalized = destination.replace(/\\/g, '/').replace(/ /g, '%20')
      return `${prefix}${normalized}${suffix}`
    }

    return `${prefix}${destination}${suffix}`
  })
}

export function isAbsoluteLocalPath(raw: string): boolean {
  const value = String(raw ?? '').trim()
  if (!value || /^(https?:|file:|data:|blob:)/i.test(value)) return false
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

export function decodeLocalPathCompat(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value || !/%[0-9A-Fa-f]{2}/.test(value) || !isAbsoluteLocalPath(value)) return value
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

export function toLocalMediaSrc(mediaPath: string): string {
  const value = String(mediaPath ?? '').trim()
  if (!value) return ''
  if (/^(https?:|file:|data:|blob:)/i.test(value)) return value
  if (/^[a-zA-Z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, '/')}`
  if (value.startsWith('\\\\')) return `file:${value.replace(/\\/g, '/')}`
  if (value.startsWith('/')) return `file://${value}`
  return value
}

export function markdownMediaUrlTransform(url: string): string {
  const value = String(url ?? '').trim()
  if (!value) return ''
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) return value.replace(/\\/g, '/')
  if (value.startsWith('/') && !value.startsWith('//')) return value
  return defaultUrlTransform(value)
}
