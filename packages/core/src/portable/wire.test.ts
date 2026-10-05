import { describe, expect, it } from 'vitest'
import { normalizeInboundResponse } from './wire'

describe('wire response normalization', () => {
  it('bounds attacker-controlled remote error text', () => {
    const response = normalizeInboundResponse('req-1', {
      v: 1,
      requestId: 'req-1',
      ok: false,
      error: 'IO',
      message: 'x'.repeat(100_000)
    })
    expect(response.ok).toBe(false)
    expect(response.error).toBe('IO')
    expect(response.message?.length).toBe(1024)
  })

  it('rejects malformed success and error-code types', () => {
    const response = normalizeInboundResponse('req-2', {
      v: 1,
      requestId: 'req-2',
      ok: 'yes' as unknown as boolean,
      error: '../BAD',
      message: 'remote failure'
    })
    expect(response.ok).toBe(false)
    expect(response.error).toBe('REMOTE_ERROR')
    expect(response.message).toBe('remote failure')
  })
})
