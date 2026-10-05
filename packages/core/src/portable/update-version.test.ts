import { describe, expect, it } from 'vitest'
import {
  comparableAppVersion,
  compareReleaseRevisions,
  compareReleases,
  isNewerRelease,
  isNewerVersion,
  parseBuildLabel,
  parseReleaseRevision,
  pickNewestUpdate
} from './update-version'

describe('parseBuildLabel', () => {
  it('reads DDMMYY as a calendar date', () => {
    expect(parseBuildLabel('140926')).toEqual([2026, 9, 14])
    expect(parseBuildLabel('010126')).toEqual([2026, 1, 1])
    expect(parseBuildLabel('dev')).toBeNull()
  })

  it('reads legacy n-DDMMYY but isolates it from the PeerSync release line', () => {
    expect(parseBuildLabel('n-140926')).toEqual([2026, 9, 14])
    expect(isNewerRelease('2.0.0', 'n-220926', '0.0.0', '230926')).toBe(false)
    expect(isNewerRelease('0.0.0', '230926', '2.0.0', 'n-220926')).toBe(false)
  })
})

describe('isNewerVersion', () => {
  it('compares semver only', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('lets an old core see the date as a fourth version part', () => {
    expect(comparableAppVersion('0.0.0', '140926')).toBe('0.0.0.20260914')
    expect(isNewerVersion('0.0.0.20260914', '0.0.0')).toBe(true)
    expect(isNewerVersion('0.0.0.20260914', '0.0.0.20260911')).toBe(true)
    expect(isNewerVersion('0.0.0.20260911', '0.0.0.20260914')).toBe(false)
  })
})

describe('isNewerRelease', () => {
  it('uses build label when the app version is the same', () => {
    expect(isNewerRelease('0.0.0', '150926', '0.0.0', '140926')).toBe(true)
    expect(isNewerRelease('0.0.0', '140926', '0.0.0', '150926')).toBe(false)
    expect(isNewerRelease('0.0.0', '140926', '0.0.0', '140926')).toBe(false)
  })

  it('orders DDMMYY by date, not lexicographically', () => {
    expect(isNewerRelease('0.0.0', '010126', '0.0.0', '311225')).toBe(true)
    expect(isNewerRelease('0.0.0', '311225', '0.0.0', '010126')).toBe(false)
  })

  it('treats a dated build as newer than an undated label', () => {
    expect(isNewerRelease('0.0.0', '140926', '0.0.0', 'dev')).toBe(true)
    expect(isNewerRelease('0.0.0', 'dev', '0.0.0', '140926')).toBe(false)
  })

  it('prefers a higher app version over an older build date', () => {
    expect(isNewerRelease('1.0.1', '010101', '1.0.0', '140926')).toBe(true)
    expect(compareReleases('1.0.0', '150926', '1.0.1', '010101')).toBe(-1)
  })
})

describe('calendar validation', () => {
  it('rejects impossible dates instead of advertising a future update', () => {
    for (const label of ['310226', '290225', '000126', 'n-310226']) {
      expect(parseBuildLabel(label)).toBeNull()
      expect(isNewerRelease('9.0.0', label, '0.0.0', '031026')).toBe(false)
    }
    expect(parseBuildLabel('290224')).toEqual([2024, 2, 29])
  })
})

describe('release revision', () => {
  it('accepts only bounded non-negative integers', () => {
    expect(parseReleaseRevision(0)).toBe(0)
    expect(parseReleaseRevision(184)).toBe(184)
    expect(parseReleaseRevision('184')).toBe(184)
    expect(parseReleaseRevision(undefined)).toBe(0)
    expect(parseReleaseRevision(-1)).toBe(0)
    expect(parseReleaseRevision(1.5)).toBe(0)
    expect(parseReleaseRevision('1e3')).toBe(0)
    expect(parseReleaseRevision('  ')).toBe(0)
    expect(parseReleaseRevision(Number.MAX_SAFE_INTEGER)).toBe(0)
    expect(parseReleaseRevision(true)).toBe(0)
  })

  it('separates two official builds that share one calendar date', () => {
    expect(isNewerRelease('0.0.0', '031026', '0.0.0', '031026', 184, 183)).toBe(true)
    expect(isNewerRelease('0.0.0', '031026', '0.0.0', '031026', 183, 184)).toBe(false)
    expect(compareReleases('0.0.0', '031026', '0.0.0', '031026', 184, 184)).toBe(0)
    expect(compareReleaseRevisions(184, 183)).toBe(1)
  })

  it('keeps a pre-revision same-day peer from looking newer', () => {
    // A peer that predates the revision field reports 0; a local r5 must not be
    // downgraded by it, and an r0 peer must not be offered as an update.
    expect(isNewerRelease('0.0.0', '031026', '0.0.0', '031026', 0, 5)).toBe(false)
    expect(isNewerRelease('0.0.0', '031026', '0.0.0', '031026', 5, 0)).toBe(true)
  })

  it('never lets the revision override a different calendar date', () => {
    expect(isNewerRelease('0.0.0', '041026', '0.0.0', '031026', 1, 9999)).toBe(true)
    expect(isNewerRelease('0.0.0', '031026', '0.0.0', '041026', 9999, 1)).toBe(false)
  })

  it('never lets the revision order the legacy n-DDMMYY lineage', () => {
    expect(isNewerRelease('0.0.0', 'n-031026', '0.0.0', 'n-031026', 9999, 1)).toBe(false)
  })

  it('picks the highest revision when every offer shares one date', () => {
    const best = pickNewestUpdate(
      [
        { peerId: 'a', appVersion: '0.0.0', buildLabel: '031026', releaseRevision: 183, available: true, compatible: true },
        { peerId: 'b', appVersion: '0.0.0', buildLabel: '031026', releaseRevision: 184, available: true, compatible: true },
        { peerId: 'c', appVersion: '0.0.0', buildLabel: '031026', available: true, compatible: true }
      ],
      '0.0.0',
      '031026',
      undefined,
      182
    )
    expect(best?.peerId).toBe('b')
  })

  it('offers nothing from a peer on the same date at the same revision', () => {
    const best = pickNewestUpdate(
      [
        { peerId: 'a', appVersion: '0.0.0', buildLabel: '031026', releaseRevision: 184, available: true, compatible: true }
      ],
      '0.0.0',
      '031026',
      undefined,
      184
    )
    expect(best).toBeNull()
  })
})

describe('pickNewestUpdate', () => {
  const local = { version: '0.0.0', build: '120926' }

  it('picks the newest among several clients', () => {
    const best = pickNewestUpdate(
      [
        { peerId: 'a', appVersion: '0.0.0', buildLabel: '130926', available: true, compatible: true },
        { peerId: 'b', appVersion: '0.0.0', buildLabel: '150926', available: true, compatible: true },
        { peerId: 'c', appVersion: '0.0.0', buildLabel: '140926', available: true, compatible: true }
      ],
      local.version,
      local.build
    )
    expect(best?.peerId).toBe('b')
  })

  it('ignores older, offline-incompatible, and unavailable sources', () => {
    const best = pickNewestUpdate(
      [
        { peerId: 'old', appVersion: '0.0.0', buildLabel: '110926', available: true, compatible: true },
        { peerId: 'bad', appVersion: '0.0.1', buildLabel: '150926', available: true, compatible: false },
        { peerId: 'empty', appVersion: '0.0.1', buildLabel: '150926', available: false, compatible: true },
        { peerId: 'ok', appVersion: '0.0.0', buildLabel: '140926', available: true, compatible: true }
      ],
      local.version,
      local.build
    )
    expect(best?.peerId).toBe('ok')
  })

  it('prefers the selected peer when versions are equal', () => {
    const best = pickNewestUpdate(
      [
        { peerId: 'a', appVersion: '0.0.0', buildLabel: '150926', available: true, compatible: true },
        { peerId: 'b', appVersion: '0.0.0', buildLabel: '150926', available: true, compatible: true }
      ],
      local.version,
      local.build,
      'b'
    )
    expect(best?.peerId).toBe('b')
  })
})
