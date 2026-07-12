import { describe, expect, it } from 'vitest'
import { resolveLive2dModelUrl } from '../src/live2d/live2dModels'

describe('Live2D model URL resolution', () => {
  it('keeps remote URLs unchanged', () => {
    expect(resolveLive2dModelUrl('https://cdn.example.com/model/model3.json', 'file:///C:/app/dist/index.html#/pet')).toBe(
      'https://cdn.example.com/model/model3.json',
    )
  })

  it('resolves root-style model paths beside the packaged renderer entry', () => {
    expect(resolveLive2dModelUrl('/live2d/Haru/Haru.model3.json', 'file:///C:/app/dist/index.html#/pet')).toBe(
      'file:///C:/app/dist/live2d/Haru/Haru.model3.json',
    )
  })

  it('resolves the same path against the dev server root', () => {
    expect(resolveLive2dModelUrl('/live2d/Haru/Haru.model3.json', 'http://127.0.0.1:5173/#/pet')).toBe(
      'http://127.0.0.1:5173/live2d/Haru/Haru.model3.json',
    )
  })
})
