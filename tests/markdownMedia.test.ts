import { describe, expect, it } from 'vitest'
import {
  applyMarkdownLocalImagePathCompat,
  decodeLocalPathCompat,
  isAbsoluteLocalPath,
  markdownMediaUrlTransform,
  toLocalMediaSrc,
} from '../src/utils/markdownMedia'

describe('Markdown local media compatibility', () => {
  it('normalizes Windows image destinations without changing remote URLs', () => {
    expect(applyMarkdownLocalImagePathCompat('![shot](C:\\My Files\\shot.png)')).toBe('![shot](C:/My%20Files/shot.png)')
    expect(applyMarkdownLocalImagePathCompat('![remote](https://example.com/shot.png)')).toBe(
      '![remote](https://example.com/shot.png)',
    )
  })

  it('detects and decodes local absolute paths', () => {
    expect(isAbsoluteLocalPath('C:/My%20Files/shot.png')).toBe(true)
    expect(isAbsoluteLocalPath('https://example.com/shot.png')).toBe(false)
    expect(decodeLocalPathCompat('C:/My%20Files/shot.png')).toBe('C:/My Files/shot.png')
  })

  it('blocks direct local file URLs and keeps safe remote URLs', () => {
    expect(toLocalMediaSrc('C:\\My Files\\shot.png')).toBe('')
    expect(toLocalMediaSrc('file:///C:/My%20Files/shot.png')).toBe('')
    expect(decodeLocalPathCompat('file:///C:/My%20Files/shot.png')).toBe('C:\\My Files\\shot.png')
    expect(toLocalMediaSrc('https://example.com/shot.png')).toBe('https://example.com/shot.png')
    expect(markdownMediaUrlTransform('C:\\My Files\\shot.png')).toBe('C:/My Files/shot.png')
    expect(markdownMediaUrlTransform('https://example.com/shot.png')).toBe('https://example.com/shot.png')
    expect(markdownMediaUrlTransform('javascript:alert(1)')).toBe('')
  })
})
