export interface IoFilterSpec {
  include?: string[]
  exclude?: string[]
}

export interface IoListSortSpec {
  column: 'name' | 'type' | 'size' | 'date'
  desc: boolean
}

export interface IoListEntry {
  relativePath: string
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtimeMs: number
  skipped?: 'link'
}

export interface IoStableFileHash {
  relativePath: string
  size: number
  mtimeMs: number
  contentHash: string
}

export interface IoStatPathResult {
  entry?: IoListEntry
  error?: { code: string; message: string }
}

/**
 * Wire mirror of `pathguard.FileStat`. `dev`/`ino` are strings because the
 * worker boundary serializes with JSON.
 */
export interface IoFileStat {
  size: number
  mtimeMs: number
  dev: string
  ino: string
  birthtimeMs: number
  mode: number
}

export interface IoManifestItem {
  relativePath: string
  size: number
  mtimeMs: number
  contentHash: string
}

export interface IoManifestSnapshot {
  scanId: string
  relativePath: string
  items: IoManifestItem[]
  fileCount: number
  totalBytes: number
  entriesDigest: string
  createdAtMs: number
  expiresAtMs: number
  hardExpiresAtMs: number
}

export type IoWorkerRequest =
  | { id: number; op: 'open-read'; path: string }
  | { id: number; op: 'open-read-root'; root: string; rel: string }
  | { id: number; op: 'open-write'; path: string; size: number; exclusive?: boolean }
  | { id: number; op: 'read'; offset: number; length: number }
  | { id: number; op: 'write'; offset: number; data: Uint8Array }
  | { id: number; op: 'sync' }
  | { id: number; op: 'close-handle' }
  | { id: number; op: 'hash'; path: string }
  | { id: number; op: 'sha256'; path: string }
  | { id: number; op: 'stable-hash'; root: string; rel: string; hashCachePath?: string | null }
  | { id: number; op: 'manifest'; root: string; rel: string; filter?: IoFilterSpec | null; maxEntries: number; scanId: string; hashCachePath?: string | null }
  | { id: number; op: 'list-all'; root: string; rel: string; sort?: IoListSortSpec | null }
  | { id: number; op: 'stat-path'; root: string; rel: string }
  | { id: number; op: 'stat-path-batch'; root: string; rels: string[] }
  | { id: number; op: 'stat-file'; path: string }
  | { id: number; op: 'prepare-put'; root: string; rel: string }
  | { id: number; op: 'unlink'; path: string; ignoreMissing?: boolean }
  | { id: number; op: 'rename'; from: string; to: string }
  | { id: number; op: 'link'; from: string; to: string }
  | { id: number; op: 'copy-exclusive'; from: string; to: string }
  | { id: number; op: 'claim-exclusive-copy'; to: string }
  | { id: number; op: 'copy-into-claim'; from: string }
  | { id: number; op: 'chmod'; path: string; mode: number }
  | { id: number; op: 'atomic-write'; path: string; data: Uint8Array }

export type IoWorkerResult =
  | { size: number }
  | { path: string; size: number }
  | { path: string }
  | { data: Uint8Array }
  | { hex: string; size: number }
  | { stable: IoStableFileHash }
  | { manifest: IoManifestSnapshot }
  | { entries: IoListEntry[] }
  | { entry: IoListEntry | null }
  | { stats: IoStatPathResult[] }
  | { stat: IoFileStat | null }
  | { identity: string }
  | { ok: true }

export type IoWorkerMessage =
  | { id: number; type: 'result'; ok: true; result: IoWorkerResult }
  | { id: number; type: 'result'; ok: false; error: { code: string; message: string } }
  | { id: number; type: 'progress'; bytes: number }
