import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '',
  },
}))

import { createLive2dModelId } from '../electron/modelScanner'

describe('Live2D model scanner', () => {
  it('keeps non-ASCII folder names distinct', () => {
    expect(createLive2dModelId('Haru')).toBe('haru')
    expect(createLive2dModelId('灵小狗')).toBe('灵小狗')
    expect(createLive2dModelId('艾玛')).toBe('艾玛')
    expect(createLive2dModelId('波奇酱 2.0')).toBe('波奇酱_2.0')
  })
})
