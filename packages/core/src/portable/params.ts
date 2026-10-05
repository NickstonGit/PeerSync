// Validation of untrusted IPC payloads (shell → core). Every helper either
// returns a well-typed value or throws an `ipcCode`-tagged INVALID_REQUEST
// error, so dispatch code never reads properties off `unknown`.

import b4a from 'b4a'
import type { FilterSpec, ListSortSpec } from './fs-scan'
import { FILTER_MAX_PATTERNS, FILTER_PATTERN_MAX_BYTES, FILTER_TOTAL_MAX_BYTES } from './limits'
import type { CopyRequest, DestFingerprint } from './fs-engine'

export type Params = Record<string, unknown>

export type IpcError = Error & { ipcCode: string }

export function ipcError(code: string, message: string): IpcError {
  const e = new Error(message) as IpcError
  e.ipcCode = code
  return e
}

function invalid(message: string): IpcError {
  return ipcError('INVALID_REQUEST', message)
}

export function isRecord(value: unknown): value is Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Any non-object payload is treated as an empty parameter bag. */
export function asParams(payload: unknown): Params {
  return isRecord(payload) ? payload : {}
}

/** `string | null` slot: absent/null → null, anything non-string is rejected. */
export function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  return value
}

export function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`)
  return value.map(String)
}

export function parsePerms(value: unknown): { read?: boolean; write?: boolean } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw invalid('perms must be an object')
  const out: { read?: boolean; write?: boolean } = {}
  if (value.read !== undefined) {
    if (typeof value.read !== 'boolean') throw invalid('perms.read must be a boolean')
    out.read = value.read
  }
  if (value.write !== undefined) {
    if (typeof value.write !== 'boolean') throw invalid('perms.write must be a boolean')
    out.write = value.write
  }
  return out
}

export function parseFilter(value: unknown): FilterSpec | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw invalid('filter must be an object')
  const out: FilterSpec = {}
  let patternCount = 0
  let totalBytes = 0
  for (const key of ['include', 'exclude'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) throw invalid(`filter.${key} must be an array`)
    patternCount += raw.length
    if (patternCount > FILTER_MAX_PATTERNS) {
      throw invalid(`filter has more than ${FILTER_MAX_PATTERNS} patterns`)
    }
    const list: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string') throw invalid(`filter.${key} entries must be strings`)
      const bytes = b4a.byteLength(item, 'utf8')
      if (bytes > FILTER_PATTERN_MAX_BYTES) {
        throw invalid(`filter.${key} pattern exceeds ${FILTER_PATTERN_MAX_BYTES} bytes`)
      }
      totalBytes += bytes
      if (totalBytes > FILTER_TOTAL_MAX_BYTES) {
        throw invalid(`filter patterns exceed ${FILTER_TOTAL_MAX_BYTES} bytes total`)
      }
      list.push(item)
    }
    out[key] = list
  }
  return out
}

export function parseListSort(value: unknown): ListSortSpec | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw invalid('sort must be an object')
  const column = String(value.column ?? '')
  if (!['name', 'type', 'size', 'date'].includes(column)) throw invalid('sort.column is invalid')
  return { column: column as ListSortSpec['column'], desc: value.desc === true }
}

function parseDestFingerprint(value: unknown): DestFingerprint | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || typeof value.size !== 'number')
    throw invalid('destFingerprint.size must be a number')
  const hash = value.blake2b256
  if (hash !== undefined && hash !== null && typeof hash !== 'string')
    throw invalid('destFingerprint.blake2b256 must be a string')
  return { size: value.size, blake2b256: typeof hash === 'string' ? hash : null }
}

export function parsePreFlashed(value: unknown): CopyRequest['preFlashed'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid('preFlashed must be an array')
  return value.map((item, i) => {
    if (!isRecord(item)) throw invalid(`preFlashed[${i}] must be an object`)
    const { relativePath, size, mtimeMs, contentHash } = item
    if (typeof relativePath !== 'string')
      throw invalid(`preFlashed[${i}].relativePath must be a string`)
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      throw invalid(`preFlashed[${i}].size must be a non-negative integer`)
    if (mtimeMs !== undefined && (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)))
      throw invalid(`preFlashed[${i}].mtimeMs must be a finite number`)
    if (typeof contentHash !== 'string')
      throw invalid(`preFlashed[${i}].contentHash must be a string`)
    return {
      relativePath,
      size,
      mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : undefined,
      contentHash,
      destFingerprint: parseDestFingerprint(item.destFingerprint)
    }
  })
}
