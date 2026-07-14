import { describe, expect, it } from 'vitest'
import { getLiveRegionProps } from '../src/components/liveRegion'

describe('live region props', () => {
  it('maps routine updates to an atomic polite status', () => {
    expect(getLiveRegionProps('polite')).toEqual({
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': true,
    })
  })

  it('maps errors to an atomic assertive alert', () => {
    expect(getLiveRegionProps('assertive')).toEqual({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-atomic': true,
    })
  })
})
