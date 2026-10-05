/**
 * Native path helpers.
 *
 * Relative paths arrive from the wire with `/` separators and must be joined
 * onto a physical root using the host's separator. Kept out of `fs-engine.ts`
 * so low-level modules do not have to import the protocol state machine.
 */
import path from 'bare-path'

export function joinNativePart(rootPhysical: string, rel: string): string {
  return path.join(rootPhysical, ...(rel ? rel.split('/') : []))
}
