export const PEER_SILENCE_TIMEOUT_MS = 60_000

// Hard receiver/sender geometry ceiling. This is intentionally far above normal
// portable use, but prevents a peer-controlled Number.MAX_SAFE_INTEGER size from
// turning bitmap/allocation bookkeeping into an OOM/CPU DoS.
export const MAX_TRANSFER_SIZE_BYTES = 16 * 1024 * 1024 * 1024 * 1024

// Receiver asks for a bounded number of chunks at a time. With the largest
// 4 MiB chunk this caps protocol-requested in-flight payload at about 64 MiB.
export const NEED_BATCH_CHUNKS = 16

export const PROGRESS_STEP_BYTES = 2 * 1024 * 1024

export const PROGRESS_INTERVAL_MS = 500
