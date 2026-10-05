// Narrowing helpers for `catch (err: unknown)` — errno-style `code` and
// `message` are read without pretending the thrown value is a full Error.

import type { RecoveryErrorScope } from './journal'

/**
 * Operation failure carrying a stable wire code.
 *
 * Defined here rather than in `fs-engine.ts` so the disk adapter and other
 * low-level modules can raise it without importing the protocol state machine.
 */
export class EngineError extends Error {
  code: string
  /** receiver finalize: final blake2b-256 did not match the descriptor */
  digestMismatch?: boolean
  /** receiver finalize: destination changed after preview */
  staleDest?: boolean
  /** Recovery classification: an operation-scoped failure must not reset transport. */
  scope?: RecoveryErrorScope
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}

export function isErrnoCode(err: unknown, ...codes: string[]): boolean {
  const code = errorCode(err)
  return code !== undefined && codes.includes(code)
}
