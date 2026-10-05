import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  PUBLICATION_CANDIDATE_LIMIT,
  candidateParts,
  numberedCandidate,
  statIdentity
} from './publication'

const parts = candidateParts('/work', 'report', '.xlsx')
const name = (n: number) => numberedCandidate('/work/report.xlsx', n, parts, path.posix.join)

describe('publication candidate naming', () => {
  it('offers the target first and never skips the (1) suffix', () => {
    expect(name(0)).toBe('/work/report.xlsx')
    expect(name(1)).toBe('/work/report (1).xlsx')
    expect(name(2)).toBe('/work/report (2).xlsx')
    expect(name(3)).toBe('/work/report (3).xlsx')
  })

  it('produces a gap-free sequence across the whole candidate budget', () => {
    const names: string[] = []
    for (let n = 0; n < PUBLICATION_CANDIDATE_LIMIT; n++) {
      names.push(name(n))
    }
    expect(names[0]).toBe('/work/report.xlsx')
    // Every index n >= 1 must appear exactly once, so the target is followed by
    // (1), (2), ... with no missing suffix.
    for (let n = 1; n < PUBLICATION_CANDIDATE_LIMIT; n++) {
      expect(names[n]).toBe(`/work/report (${n}).xlsx`)
    }
    expect(new Set(names).size).toBe(PUBLICATION_CANDIDATE_LIMIT)
  })

  it('keeps a dotless name intact', () => {
    const plain = candidateParts('/work', 'README', '')
    expect(numberedCandidate('/work/README', 0, plain, path.posix.join)).toBe('/work/README')
    expect(numberedCandidate('/work/README', 1, plain, path.posix.join)).toBe('/work/README (1)')
  })

  it('treats every extension as part of the base name only once', () => {
    const dotted = candidateParts('/work', 'archive.tar', '.gz')
    expect(numberedCandidate('/work/archive.tar.gz', 1, dotted, path.posix.join)).toBe(
      '/work/archive.tar (1).gz'
    )
  })

  it('uses the caller path separator so Windows names stay native', () => {
    const win = candidateParts('C:\\work', 'report', '.xlsx')
    expect(numberedCandidate('C:\\work\\report.xlsx', 1, win, path.win32.join)).toBe(
      'C:\\work\\report (1).xlsx'
    )
  })
})

describe('publication object identity', () => {
  it('stringifies every part so large inode values survive', () => {
    // Inode numbers exceed the JS safe-integer range on several filesystems.
    // They must be stringified before they reach a JSON journal.
    const identity = statIdentity({ dev: 1048649, ino: '12345678901234567890', birthtimeMs: 1, mode: 33188 })
    expect(identity).toBe('1048649:12345678901234567890:1:33188')
  })

  it('round-trips a bigint-sized inode that a JS number would corrupt', () => {
    const ino = 18446744073709551615n
    const asNumber = Number(ino)
    const identity = statIdentity({ dev: 1, ino: ino.toString(), birthtimeMs: 0, mode: 0 })
    const [, recoveredIno] = identity.split(':')

    expect(recoveredIno).toBe('18446744073709551615')
    // Documented consequence: passing the raw number loses the low digits,
    // which is why the string form is the contract.
    expect(String(asNumber)).not.toBe(ino.toString())
  })
})
