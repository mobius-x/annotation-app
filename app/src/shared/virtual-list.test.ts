import { describe, expect, it } from 'vitest'
import { getVirtualRange } from './virtual-list'

describe('variable-height virtual list ranges', () => {
  it('renders only a viewport-sized window from thousands of rows', () => {
    const ids = Array.from({ length: 5000 }, (_, index) => `row-${index}`)
    const range = getVirtualRange(ids, {}, 300_000, 600, 180, 3)
    expect(range.start).toBeGreaterThan(1500)
    expect(range.end - range.start).toBeLessThan(20)
    expect(range.top + range.bottom).toBeGreaterThan(0)
  })

  it('uses measured variable heights to calculate spacer sizes', () => {
    const ids = ['short', 'tall', 'last']
    const range = getVirtualRange(ids, { short: 20, tall: 100, last: 40 }, 25, 30, 50, 0)
    expect(range).toEqual({ start: 1, end: 2, top: 20, bottom: 40 })
  })

  it('keeps the full list visible when it fits inside the viewport', () => {
    expect(getVirtualRange(['a', 'b'], {}, 0, 1000, 100, 0)).toEqual({
      start: 0,
      end: 2,
      top: 0,
      bottom: 0,
    })
  })
})
