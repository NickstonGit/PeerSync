import { describe, it, expect } from 'vitest'
import { filterDecision, destRelOf, toScanRel, dirnameRel, joinRel, ScanRegistry, canonicalManifestJson, manifestDigestHex, comparePortablePaths } from './fs-scan'
import { blake2b256Hex } from './hashing'
import b4a from 'b4a'

describe('comparePortablePaths', () => {
  it('keeps manifest ordering stable across mixed-case names', () => {
    const paths = ['z.txt', 'B.txt', 'a.txt', 'A.txt', 'b.txt']
    expect(paths.sort(comparePortablePaths)).toEqual(['A.txt', 'a.txt', 'B.txt', 'b.txt', 'z.txt'])
  })
})

describe('filterDecision', () => {
  it('keeps everything without a filter', () => {
    expect(filterDecision('a.zip', 'file')).toBe('keep')
  })

  it('drops excluded globs at any depth', () => {
    expect(filterDecision('pack.zip', 'file', { exclude: ['*.zip'] })).toBe('drop')
    expect(filterDecision('nested/pack.zip', 'file', { exclude: ['*.zip'] })).toBe('drop')
    expect(filterDecision('nested/keep.txt', 'file', { exclude: ['*.zip'] })).toBe('keep')
  })

  it('include *.txt keeps matching files only', () => {
    expect(filterDecision('a.txt', 'file', { include: ['*.txt'] })).toBe('keep')
    expect(filterDecision('a.zip', 'file', { include: ['*.txt'] })).toBe('drop')
    expect(filterDecision('sub/a.txt', 'file', { include: ['*.txt'] })).toBe('keep')
  })

  it('anchored /*.zip matches scan-root files only', () => {
    expect(filterDecision('a.zip', 'file', { include: ['/*.zip'] })).toBe('keep')
    expect(filterDecision('sub/a.zip', 'file', { include: ['/*.zip'] })).toBe('drop')
  })

  it('always keeps directories so nested includes can match', () => {
    expect(filterDecision('secret', 'dir', { exclude: ['*.zip'] })).toBe('keep')
  })
})

describe('toScanRel / destRelOf', () => {
  it('strips the scan root prefix', () => {
    expect(toScanRel('sync/f1.txt', 'sync')).toBe('f1.txt')
    expect(toScanRel('sync/sub/a.txt', 'sync')).toBe('sub/a.txt')
    expect(toScanRel('f1.txt', '')).toBe('f1.txt')
  })

  it('maps directory copy to dest/name/rest', () => {
    expect(destRelOf('', 'nested', 'nested/blob1.bin')).toBe('nested/blob1.bin')
    expect(destRelOf('incoming', 'nested', 'nested/blob1.bin')).toBe('incoming/nested/blob1.bin')
  })

  it('maps file copy to dest/filename', () => {
    expect(destRelOf('incoming', 'f1.txt', 'f1.txt')).toBe('incoming/f1.txt')
    expect(destRelOf('incoming', 'nested/deep/conf.txt', 'nested/deep/conf.txt')).toBe('incoming/conf.txt')
  })

  it('dirnameRel of a file at scan root is empty', () => {
    expect(dirnameRel('f1.txt')).toBe('')
    expect(dirnameRel('sub/a.txt')).toBe('sub')
    expect(joinRel('sync', dirnameRel('f1.txt'))).toBe('sync')
  })
})


describe('manifest cursor validation', () => {
  it('rejects malformed cursors instead of silently restarting at page zero', () => {
    const scans = new ScanRegistry()
    scans.add({
      scanId: 'scan-1',
      relativePath: '',
      items: [{ relativePath: 'a.txt', size: 1, mtimeMs: 1, contentHash: 'a'.repeat(64) }],
      fileCount: 1,
      totalBytes: 1,
      entriesDigest: 'b'.repeat(64),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      hardExpiresAtMs: Date.now() + 60 * 60_000
    })
    expect(() => scans.page('scan-1', 'c:not-a-number')).toThrow(/bad cursor/)
    expect(() => scans.page('scan-1', '0')).toThrow(/bad cursor/)
  })
})

describe('manifest snapshot lifetime and digest', () => {
  it('streaming digest is byte-for-byte compatible with the canonical JSON digest', () => {
    const items = [
      { relativePath: 'a.txt', size: 12, mtimeMs: 1234.49, contentHash: 'A'.repeat(64) },
      { relativePath: 'nested/b.bin', size: 0, mtimeMs: 9999.9, contentHash: 'b'.repeat(64) }
    ]
    const legacy = blake2b256Hex(b4a.from(canonicalManifestJson(items), 'utf8'))
    expect(manifestDigestHex(items)).toBe(legacy)
  })

  it('sweeps a snapshot whose hard expiry passed even if idle expiry is later', () => {
    const scans = new ScanRegistry()
    const t = Date.now()
    scans.add({
      scanId: 'scan-hard-expired',
      relativePath: '',
      items: [{ relativePath: 'a.txt', size: 1, mtimeMs: 1, contentHash: 'a'.repeat(64) }],
      fileCount: 1,
      totalBytes: 1,
      entriesDigest: 'b'.repeat(64),
      createdAtMs: t - 60_000,
      expiresAtMs: t + 60_000,
      hardExpiresAtMs: t - 1
    })
    scans.sweep()
    try {
      scans.page('scan-hard-expired', null)
      throw new Error('expected stale scan')
    } catch (err) {
      expect(err).toMatchObject({ code: 'STALE_SCAN' })
    }
  })

  it('extends idle expiry while never crossing the hard expiry', () => {
    const scans = new ScanRegistry()
    const before = Date.now()
    const snapshot = scans.add({
      scanId: 'scan-ttl',
      relativePath: '',
      items: [{ relativePath: 'a.txt', size: 1, mtimeMs: 1, contentHash: 'a'.repeat(64) }],
      fileCount: 1,
      totalBytes: 1,
      entriesDigest: 'b'.repeat(64),
      createdAtMs: before - 60_000,
      expiresAtMs: before + 5,
      hardExpiresAtMs: before + 30_000
    })
    scans.page('scan-ttl', null)
    expect(snapshot.expiresAtMs).toBeGreaterThan(before + 5)
    expect(snapshot.expiresAtMs).toBeLessThanOrEqual(snapshot.hardExpiresAtMs)
  })
})
