/**
 * Shared publication naming and object-identity rules.
 *
 * Every ChunkWriter must agree on these, otherwise collision suffixes, partial
 * file names and ownership proofs drift between the portable fs.v1 path
 * (core `ReceiverWriter`) and the package-level API (`DiskWriter`).
 */

/** Number of no-replace candidate names tried before reporting CONFLICT. */
export const PUBLICATION_CANDIDATE_LIMIT = 1000

export interface CandidateParts {
  dir: string
  base: string
  ext: string
}

/** Platform path join, supplied by the caller from its own path module. */
export type JoinPath = (dir: string, name: string) => string

/**
 * Split a target into the parts needed to build suffixed siblings. Callers pass
 * the results of their own path module so this module stays dependency-free.
 */
export function candidateParts(dir: string, basename: string, ext: string): CandidateParts {
  return { dir, base: basename, ext }
}

/**
 * `n = 0` yields the target itself; `n >= 1` yields `base (n).ext`.
 *
 * The first suffixed name is `base (1)`, so the sequence is `target`,
 * `target (1)`, `target (2)`, ... with no gap. The portable fs.v1 writer
 * previously used `i + 1` with `i` starting at 0, which skipped
 * `target (1)` entirely and began at `target (2)`.
 */
export function numberedCandidate(
  targetPath: string,
  n: number,
  parts: CandidateParts,
  join: JoinPath
): string {
  if (n <= 0) return targetPath
  return join(parts.dir, `${parts.base} (${n})${parts.ext}`)
}

/** Raised by `claimFreeName` when every candidate in the budget is taken. */
export class NameCollisionExhaustedError extends Error {
  constructor(readonly targetPath: string) {
    super(`no free filename available after ${PUBLICATION_CANDIDATE_LIMIT} variants: ${targetPath}`)
    this.name = 'NameCollisionExhaustedError'
  }
}

/**
 * Walk the shared candidate sequence and return the first name `tryClaim`
 * successfully publishes.
 *
 * `tryClaim` must throw an error carrying `code === 'EEXIST'` when the name is
 * already taken and must otherwise return. Ownership journalling stays with the
 * caller: the drive writer records it in a `.meta` sidecar, the portable fs.v1
 * writer in the encrypted journal, and each must persist its claim *before* the
 * namespace changes.
 */
export async function claimFreeName(
  targetPath: string,
  parts: CandidateParts,
  join: JoinPath,
  tryClaim: (candidate: string, n: number) => Promise<void>,
  isTaken: (err: unknown) => boolean
): Promise<{ candidate: string; n: number }> {
  for (let n = 0; n < PUBLICATION_CANDIDATE_LIMIT; n++) {
    // Candidate 0 is the target itself; candidate 1 is the first suffixed
    // sibling, so the first suffixed name is `base (1)` and never `base (2)`.
    const candidate = numberedCandidate(targetPath, n, parts, join)
    try {
      await tryClaim(candidate, n)
      return { candidate, n }
    } catch (err) {
      if (isTaken(err)) continue
      throw err
    }
  }
  throw new NameCollisionExhaustedError(targetPath)
}

/** PeerSync-owned markers. Also asserted by the Python layout guards. */export const PART_MARKER = '.peersync-part-'
export const PREV_MARKER = '.peersync-prev-'
export const CONFLICT_MARKER = '.peersync-conflict-'
export const RECOVERED_MARKER = '.peersync-recovered-'
/** Retained only so crash recovery still recognizes partials from old builds. */
export const LEGACY_PART_MARKER = '.altersend-part-'

/**
 * Serialize a stat identity as a single string.
 *
 * Inode and device numbers are not reliably representable as JS numbers, and
 * the journal is written through JSON.stringify, so every part is stringified
 * before it reaches durable storage.
 */
export function statIdentity(st: {
  dev: number | string
  ino: number | string
  birthtimeMs: number
  mode: number
}): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.mode}`
}
