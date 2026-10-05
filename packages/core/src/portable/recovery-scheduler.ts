export class RecoveryScheduler {
  private queued = new Set<string>()
  private running = new Set<string>()
  private lastFailure = new Map<string, number>()

  constructor(private readonly run: (peerId: string) => Promise<void>) {}

  schedule(peerId: string) {
    if (!peerId || this.queued.has(peerId) || this.running.has(peerId)) return
    const failedAt = this.lastFailure.get(peerId) ?? 0
    const delay = Math.min(60_000, Math.max(0, failedAt + 5_000 - Date.now()))
    this.queued.add(peerId)
    setTimeout(() => {
      this.queued.delete(peerId)
      if (this.running.has(peerId)) return
      this.running.add(peerId)
      void this.run(peerId).then(() => {
        this.lastFailure.delete(peerId)
      }).catch(() => {
        this.lastFailure.set(peerId, Date.now())
      }).finally(() => {
        this.running.delete(peerId)
      })
    }, delay)
  }
}
