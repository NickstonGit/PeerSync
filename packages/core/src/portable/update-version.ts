/** Compare portable update wire fields. PeerSync product versions are DDMMYY build labels; appVersion is compatibility-only. */

export function versionParts(value: string): number[] | null {
  const main = String(value ?? '').trim().split(/[+-]/, 1)[0]
  if (!/^\d+(?:\.\d+){0,3}$/.test(main)) return null
  const parts = main.split('.').map((x) => Number(x))
  return parts.every((x) => Number.isSafeInteger(x) && x >= 0) ? parts : null
}

type BuildLabelLine = 'peersync' | 'legacy' | 'other'

function buildLabelLine(value: string): BuildLabelLine {
  const label = String(value ?? '').trim()
  if (/^\d{6}$/.test(label)) return 'peersync'
  if (/^n-\d{6}$/i.test(label)) return 'legacy'
  return 'other'
}

function crossesReleaseLine(candidate: string, current: string): boolean {
  const left = buildLabelLine(candidate)
  const right = buildLabelLine(current)
  return (left === 'peersync' && right === 'legacy') || (left === 'legacy' && right === 'peersync')
}

export function parseBuildLabel(value: string): [number, number, number] | null {
  // `n-DDMMYY` is accepted only so pre-PeerSync test builds remain parseable.
  const match = /^(?:n-)?(\d{2})(\d{2})(\d{2})$/i.exec(String(value ?? '').trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = 2000 + Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return [year, month, day]
}

function compareTuples(left: number[], right: number[]): number {
  const n = Math.max(left.length, right.length)
  for (let i = 0; i < n; i++) {
    const av = left[i] ?? 0
    const bv = right[i] ?? 0
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}

export function compareBuildLabels(candidate: string, current: string): number {
  if (crossesReleaseLine(candidate, current)) return 0
  const left = parseBuildLabel(candidate)
  const right = parseBuildLabel(current)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareTuples(left, right)
}

const PEERSYNC_LABEL_RE = /^\d{6}$/
const MAX_RELEASE_REVISION = 100_000_000

/**
 * Monotonic within-day release revision; 0 when the field is absent.
 *
 * The public DDMMYY label stays unchanged in the UI. A revision is the
 * machine-orderable identity that lets two different official builds share one
 * calendar date without becoming indistinguishable to update ordering.
 */
export function parseReleaseRevision(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value < MAX_RELEASE_REVISION ? value : 0
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) return 0
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) && parsed < MAX_RELEASE_REVISION ? parsed : 0
  }
  return 0
}

export function compareReleaseRevisions(candidate: unknown, current: unknown): number {
  return compareTuples([parseReleaseRevision(candidate)], [parseReleaseRevision(current)])
}

export function compareReleases(
  candidateVersion: string,
  candidateBuild: string,
  currentVersion: string,
  currentBuild: string,
  candidateRevision: unknown = 0,
  currentRevision: unknown = 0
): number {
  // PeerSync DDMMYY is a separate product version lineage. A pre-rename n-DDMMYY
  // build must never become an automatic update source merely because it used
  // the legacy semver line.
  if (crossesReleaseLine(candidateBuild, currentBuild)) return 0

  for (const label of [candidateBuild, currentBuild]) {
    if (buildLabelLine(label) !== 'other' && !parseBuildLabel(label)) return 0
  }
  const a = versionParts(candidateVersion)
  const b = versionParts(currentVersion)
  if (!a || !b) return 0
  const byVersion = compareTuples(a, b)
  if (byVersion !== 0) return byVersion
  const byLabel = compareBuildLabels(candidateBuild, currentBuild)
  if (byLabel !== 0) return byLabel
  // Same product version and same calendar date: the revision decides. A label
  // outside the PeerSync DDMMYY lineage stays historically incomparable.
  if (!PEERSYNC_LABEL_RE.test(String(candidateBuild ?? '').trim())) return 0
  if (!PEERSYNC_LABEL_RE.test(String(currentBuild ?? '').trim())) return 0
  return compareReleaseRevisions(candidateRevision, currentRevision)
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareReleases(candidate, '', current, '') > 0
}

/** Old cores compare only appVersion. Fold DDMMYY (or legacy n-DDMMYY) into a 4th semver part. */
export function comparableAppVersion(appVersion: string, buildLabel: string): string {
  const parts = versionParts(appVersion)
  if (!parts || parts.length === 0) return String(appVersion || '0.0.0')
  if (parts.length >= 4) return parts.join('.')
  const parsed = parseBuildLabel(buildLabel)
  if (!parsed) return parts.join('.')
  const padded = [...parts]
  while (padded.length < 3) padded.push(0)
  const stamp = parsed[0] * 10000 + parsed[1] * 100 + parsed[2]
  return `${padded[0]}.${padded[1]}.${padded[2]}.${stamp}`
}

export function isNewerRelease(
  candidateVersion: string,
  candidateBuild: string,
  currentVersion: string,
  currentBuild: string,
  candidateRevision: unknown = 0,
  currentRevision: unknown = 0
): boolean {
  return (
    compareReleases(
      candidateVersion,
      candidateBuild,
      currentVersion,
      currentBuild,
      candidateRevision,
      currentRevision
    ) > 0
  )
}

export interface UpdateOffer {
  peerId: string
  appVersion: string
  buildLabel: string
  /** Machine-orderable within-day identity; 0/absent on pre-revision peers. */
  releaseRevision?: number
  available: boolean
  compatible: boolean
}

export function pickNewestUpdate<T extends UpdateOffer>(
  offers: T[],
  currentVersion: string,
  currentBuild: string,
  preferredPeerId?: string,
  currentRevision: unknown = 0
): T | null {
  const preferred = String(preferredPeerId ?? '').toLowerCase()
  let best: T | null = null
  for (const offer of offers) {
    if (!offer?.available || !offer.compatible) continue
    if (!isNewerRelease(offer.appVersion, offer.buildLabel, currentVersion, currentBuild, offer.releaseRevision, currentRevision)) {
      continue
    }
    if (!best) {
      best = offer
      continue
    }
    const cmp = compareReleases(
      offer.appVersion,
      offer.buildLabel,
      best.appVersion,
      best.buildLabel,
      offer.releaseRevision,
      best.releaseRevision
    )
    if (cmp > 0) {
      best = offer
      continue
    }
    if (cmp === 0 && preferred && String(offer.peerId).toLowerCase() === preferred) {
      best = offer
    }
  }
  return best
}
