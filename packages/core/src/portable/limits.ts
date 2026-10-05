// fs.v1/chat.v1 limits. Single source of truth.

export const LIST_PAGE_SIZE = 128
export const LIST_SNAPSHOT_TTL_MS = 30 * 1000
export const LIST_MAX_ENTRIES = 50_000
export const LIST_MAX_SNAPSHOTS = 8
export const DIRECTORY_METADATA_CONCURRENCY = 32
export const MANIFEST_PAGE_SIZE = 128
export const MANIFEST_MAX_ENTRIES = 100_000
export const MANIFEST_HASH_CONCURRENCY = 4
export const SCAN_TTL_MS = 10 * 60 * 1000
export const CHAT_TEXT_MAX_BYTES = 8192
export const CHAT_MESSAGE_ID_MAX_LEN = 128
export const CHAT_HISTORY_MAX_STORED = 5000
export const CHAT_HISTORY_PAGE_MAX = 64
// Leave ample room for the outer IPC response envelope and future metadata.
export const CHAT_HISTORY_RESPONSE_BUDGET = 512 * 1024
export const CONCURRENT_TRANSFERS_PER_PEER = 2
export const REMOTE_INITIATED_JOURNAL_MAX_PER_PEER = 256
export const FILTER_MAX_PATTERNS = 64
export const FILTER_PATTERN_MAX_BYTES = 512
export const FILTER_TOTAL_MAX_BYTES = 16 * 1024
export const UPDATE_SERVE_MAX_CONCURRENT = 2
export const IPC_MAX_FRAME = 1024 * 1024
export const WIRE_MAX_JSON = 900 * 1024
// Keep worst-case statBatch request + response below WIRE_MAX_JSON even with 4 KiB paths.
export const STAT_BATCH_WIRE_TARGETS = 64
export const REL_PATH_MAX_BYTES = 4096
export const NAME_MAX_LEN = 256
export const ID_MAX_LEN = 128
export const WALK_MAX_DEPTH = 64
// Portable manifests already support 100k leaves; copy uses a bounded dispatcher,
// so keep one explicit product ceiling instead of an unrelated dead 10k limit.
export const PUT_FILES_MAX = MANIFEST_MAX_ENTRIES

export type FsOperation = 'LIST' | 'STAT' | 'GET' | 'MANIFEST' | 'MKDIR' | 'PUT'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const HEX64_RE = /^[0-9a-f]{64}$/i
// Path-safe opaque identifier accepted on wire/journal boundaries. UUIDs and
// legacy test/dev ids such as `op-1` fit; path separators, drive/ADS colons,
// dots-as-segments and other filename metacharacters do not.
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
