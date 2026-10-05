import { describe, expect, it } from 'vitest'
import { firstFreePath } from './paths'

describe('firstFreePath', () => {
  it('returns a numbered candidate when the original is occupied', async () => {
    const result = await firstFreePath('/tmp/report.txt', async (candidate) => candidate.endsWith('report (2).txt'))
    expect(result).toMatch(/report \(2\)\.txt$/)
  })

  it('fails closed when all rename variants are occupied', async () => {
    await expect(firstFreePath('/tmp/report.txt', async () => false)).rejects.toThrow(/No free filename available/)
  })
})
