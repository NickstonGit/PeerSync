import { describe, expect, it } from 'vitest'
import { TransferSwarm } from './swarm'

type TimeoutHarness = {
  withTimeout(promise: Promise<unknown>, ms: number, operation: string): Promise<void>
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  const harness = Object.create(TransferSwarm.prototype) as TimeoutHarness
  return harness.withTimeout(promise, ms, 'test operation')
}

describe('TransferSwarm announcement timeout', () => {
  it('propagates the underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('announce failed')), 100)).rejects.toThrow(
      'announce failed'
    )
  })

  it('rejects instead of reporting success when the operation times out', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow(
      'test operation timed out after 20ms'
    )
  })
})
