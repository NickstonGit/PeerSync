/**
 * Fail-closed request admission for the PSNCore stdio boundary.
 *
 * The Python shell already caps its own unanswered-request map, but Core must
 * not depend on that: the handler set, its cancellation tokens and the pending
 * filesystem work behind it all live here. A caller that ignores the shell's
 * bound (a bug, a future transport, a hostile pipe) must not be able to grow
 * that set without limit.
 *
 * Admission is a hard cap rather than a queue on purpose. A queued request owns
 * no handler yet, so its cancellation token cannot be honoured and the caller's
 * timeout can expire while the request silently sits behind the cap. Refusing
 * immediately keeps "refused" and "running" distinguishable for the caller.
 */

export class RequestAdmissionGate {
  private active = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`request admission limit must be a positive integer, got ${limit}`)
    }
  }

  /** Number of admitted handlers that have not returned yet. */
  get count(): number {
    return this.active
  }

  get saturated(): boolean {
    return this.active >= this.limit
  }

  /** Admit one request. False means the cap is reached and nothing was admitted. */
  tryEnter(): boolean {
    if (this.saturated) return false
    this.active += 1
    return true
  }

  /** Release an admitted request. Never lets the count go below zero. */
  leave(): void {
    if (this.active <= 0) return
    this.active -= 1
    if (this.active !== 0) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }

  /** Resolves once no request is admitted; used as the shutdown barrier. */
  async waitForDrain(): Promise<void> {
    if (this.active === 0) return
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve))
  }
}