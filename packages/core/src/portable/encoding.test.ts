import { describe, it, expect } from 'vitest'
import { canonicalEncoding, uuidv4 } from './encoding'

describe('canonicalEncoding', () => {
  it('sorts object keys and tags types', () => {
    expect(canonicalEncoding({ b: 2, a: 'x' })).toBe('{s:"a"=>s:"x",s:"b"=>n:2}')
  })

  it('is stable regardless of insertion order', () => {
    const a = canonicalEncoding({ size: 1, collision: 'rename' })
    const b = canonicalEncoding({ collision: 'rename', size: 1 })
    expect(a).toBe(b)
  })

  it('encodes nested fingerprints', () => {
    const s = canonicalEncoding({
      destFingerprint: { size: 10, blake2b256: 'ab' },
      sourceFingerprint: null
    })
    expect(s).toContain('s:"blake2b256"')
    expect(s).toContain('null')
  })
})

describe('uuidv4', () => {
  it('returns rfc-like uuid', () => {
    expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
