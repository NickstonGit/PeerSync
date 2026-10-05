import { describe, expect, it } from 'vitest'
import { parseFilter } from './params'
import { FILTER_MAX_PATTERNS, FILTER_PATTERN_MAX_BYTES } from './limits'

describe('portable filter input limits', () => {
  it('accepts a normal bounded filter', () => {
    expect(parseFilter({ include: ['*.pdf'], exclude: ['tmp/*'] })).toEqual({
      include: ['*.pdf'], exclude: ['tmp/*']
    })
  })

  it('rejects pattern-count amplification', () => {
    expect(() => parseFilter({ include: Array(FILTER_MAX_PATTERNS + 1).fill('*') })).toThrow(/more than/)
  })

  it('rejects oversized patterns and non-string entries', () => {
    expect(() => parseFilter({ include: ['x'.repeat(FILTER_PATTERN_MAX_BYTES + 1)] })).toThrow(/exceeds/)
    expect(() => parseFilter({ include: [123] })).toThrow(/must be strings/)
  })
})
