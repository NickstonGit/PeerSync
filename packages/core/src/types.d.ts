declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(handle: unknown): void
declare function setInterval(callback: () => void, ms: number): unknown
declare function clearInterval(handle: unknown): void

declare module 'hypercore-crypto' {
  export function randomBytes(n: number): Buffer
  export function discoveryKey(topic: Uint8Array): Uint8Array
  export interface KeyPair {
    publicKey: Uint8Array
    secretKey: Uint8Array
  }
  export function keyPair(seed?: Uint8Array): KeyPair
  export function hash(data: Uint8Array | Uint8Array[], out?: Uint8Array): Uint8Array
  export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array
  export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean

  const _default: {
    randomBytes: typeof randomBytes
    discoveryKey: typeof discoveryKey
    keyPair: typeof keyPair
    hash: typeof hash
    sign: typeof sign
    verify: typeof verify
  }
  export default _default
}

declare module 'hyperdb' {
  export interface HyperDBInstance {
    insert(collection: string, record: unknown): Promise<void>
    get(collection: string, key: Record<string, string>): Promise<Record<string, unknown> | null>
    delete(collection: string, key: Record<string, string>): Promise<void>
    find(
      collection: string,
      query?: Record<string, unknown>
    ): AsyncIterable<Record<string, unknown>>
    flush(): Promise<void>
    close(): Promise<void>
  }
  const HyperDB: {
    rocks(path: string, definition: unknown): HyperDBInstance
    bee(core: unknown, definition: unknown): HyperDBInstance
  }
  export default HyperDB
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'events'

  export interface NoiseKeyPair {
    publicKey: Uint8Array
    secretKey: Uint8Array
  }
  export interface PeerInfo {
    publicKey: Uint8Array
  }
  export interface PeerSocket {
    remotePublicKey: Uint8Array
    handshakeHash: Uint8Array | null
    /** underlying UDX stream; present on live connections */
    rawStream?: { remoteHost?: string }
    on(event: 'close', cb: () => void): this
    on(event: 'drain', cb: () => void): this
    off(event: 'drain', cb: () => void): this
    on(event: 'error', cb: (err: Error) => void): this
    destroy(err?: Error): void
  }
  export interface SwarmDiscoverySession {
    flushed(): Promise<void>
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: {
      keyPair?: NoiseKeyPair
      firewall?: (remotePublicKey: Uint8Array) => boolean
      relayThrough?: ((force: boolean, swarm: unknown) => Uint8Array[] | null) | Uint8Array[] | null
      bootstrap?: string[]
      dht?: unknown
    })
    readonly keyPair: NoiseKeyPair
    flush(): Promise<boolean>
    readonly dht: {
      connect(publicKey: Uint8Array, opts?: unknown): unknown
      ready(): Promise<void>
      address?: () => { host?: string; port: number; family?: number | string } | null
      nat?: { type?: string }
      udx?: {
        createSocket(opts?: { reuseAddress?: boolean }): {
          bind(port?: number, host?: string): void
          close(): Promise<void> | void
          addMembership?(group: string, iface?: string): void
          setTTL?(ttl: number): void
          trySend(buffer: Uint8Array, port: number, host: string, ttl?: number): void
          on(event: 'message', cb: (msg: Uint8Array, from: { host: string; port: number }) => void): unknown
          on(event: 'error', cb: (err: Error) => void): void
        }
        networkInterfaces(): Array<{ host: string; family: number | string; internal?: boolean }>
      }
    }
    join(
      discoveryKey: Uint8Array,
      opts?: { server?: boolean; client?: boolean }
    ): SwarmDiscoverySession
    leave(discoveryKey: Uint8Array): Promise<void> | unknown
    status(discoveryKey: Uint8Array): { refresh(): Promise<boolean | void> } | null
    destroy(): Promise<void>
    on(event: 'connection', cb: (socket: PeerSocket, info: PeerInfo) => void): this
    on(event: 'update', cb: () => void): this
  }
}

declare module 'hyperdht' {
  export interface MutableRecord {
    seq: number
    value: Uint8Array
    signature: Uint8Array
  }
  export default class HyperDHT {
    mutableGet(
      publicKey: Uint8Array,
      opts?: { latest?: boolean; seq?: number }
    ): Promise<MutableRecord | null>
    destroy(): Promise<void>
  }
}

declare module 'protomux' {
  export interface ProtomuxMessage<T = unknown> {
    send(message: T): void
  }
  export interface ProtomuxChannel {
    addMessage<T = unknown>(opts: {
      encoding: unknown
      onmessage?: (message: T) => void
    }): ProtomuxMessage<T>
    open(): void
    close(): void
    fullyOpened(): Promise<boolean>
    readonly drained: boolean
  }
  export default class Protomux {
    static from(socket: unknown): Protomux
    createChannel(opts: {
      protocol: string
      onopen?: () => void
      onclose?: (isRemote: boolean) => void
    }): ProtomuxChannel | null
  }
}

declare module 'compact-encoding' {
  export interface EncodingState {
    start: number
    end: number
    buffer: Uint8Array | null
  }
  export interface Encoding<T> {
    preencode(state: EncodingState, value: T): void
    encode(state: EncodingState, value: T): void
    decode(state: EncodingState): T
  }
  export const json: unknown
  export const string: Encoding<string>
  export const uint: Encoding<number>
  export const raw: Encoding<Uint8Array>
  const _default: {
    json: typeof json
    string: typeof string
    uint: typeof uint
    raw: typeof raw
  }
  export default _default
}

declare module 'bare-process' {
  type ProcessEvent = 'beforeExit' | 'SIGTERM' | 'SIGINT' | 'suspend' | 'resume'
  interface StdinLike {
    on(event: 'data', handler: (chunk: Uint8Array) => void): void
    on(event: 'end' | 'close', handler: () => void): void
    open?(cb?: (err: Error | null) => void): void
  }
  interface StdoutLike {
    write(data: Uint8Array | string): boolean
    open?(cb?: (err: Error | null) => void): void
  }
  const process: {
    stdin: StdinLike
    stdout: StdoutLike
    stderr: StdoutLike
    env: Record<string, string | undefined>
    exit(code?: number): never
    on(event: ProcessEvent, handler: (...args: unknown[]) => void): void
  }
  export default process
}

declare module 'bare-fs' {
  interface RmOptions {
    recursive?: boolean
    force?: boolean
  }
  interface MkdirOptions {
    recursive?: boolean
  }
  interface Stats {
    size: number
    isFile(): boolean
  }
  interface FileHandle {
    sync(): Promise<void>
    close(): Promise<void>
  }

  export function rmSync(path: string, opts?: RmOptions): void
  export function readFileSync(path: string, encoding: BufferEncoding): string
  export function mkdirSync(path: string, opts?: MkdirOptions): void
  export function writeFileSync(path: string, data: string, encoding: BufferEncoding): void
  export function renameSync(from: string, to: string): void
  export function unlinkSync(path: string): void

  export const promises: {
    rm(path: string, opts?: RmOptions): Promise<void>
    unlink(path: string): Promise<void>
    readFile(path: string, encoding: BufferEncoding): Promise<string>
    writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(path: string, opts?: MkdirOptions): Promise<void>
    stat(path: string): Promise<Stats>
    open(path: string, flags: string): Promise<FileHandle>
  }

  const _default: {
    rmSync: typeof rmSync
    readFileSync: typeof readFileSync
    mkdirSync: typeof mkdirSync
    writeFileSync: typeof writeFileSync
    renameSync: typeof renameSync
    unlinkSync: typeof unlinkSync
    promises: typeof promises
  }
  export default _default
}

declare module 'bare-rpc' {
  export interface RPCRequest {
    readonly command: number
    readonly data: Uint8Array
    reply(data: string | Uint8Array): void
  }
  export interface RPCMessage {
    send(data: string | Uint8Array): void
  }
  export interface RPCRequestHandle extends RPCMessage {
    reply(): Promise<Uint8Array>
  }

  export default class RPC {
    constructor(stream: unknown, onmessage: (req: RPCRequest) => void | Promise<void>)
    event(command: number): RPCMessage
    request(command: number): RPCRequestHandle
  }
}

// Bare runtime globals exposed in worklet contexts only.
interface BareGlobal {
  IPC: unknown
  argv: string[]
  pid: number
  env: Record<string, string | undefined>
}
declare var Bare: BareGlobal
declare var Pear: unknown

declare module 'bare-path' {
  const p: {
    join(...parts: string[]): string
    dirname(p: string): string
    basename(p: string, ext?: string): string
    extname(p: string): string
    normalize(p: string): string
    sep: string
  }
  export = p
}

declare module 'sodium-javascript' {
  export const crypto_secretbox_KEYBYTES: number
  export const crypto_secretbox_NONCEBYTES: number
  export const crypto_secretbox_MACBYTES: number
  export function crypto_secretbox_easy(ciphertext: Uint8Array, message: Uint8Array, nonce: Uint8Array, key: Uint8Array): void
  export function crypto_secretbox_open_easy(message: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): boolean
  const sodium: {
    crypto_secretbox_KEYBYTES: typeof crypto_secretbox_KEYBYTES
    crypto_secretbox_NONCEBYTES: typeof crypto_secretbox_NONCEBYTES
    crypto_secretbox_MACBYTES: typeof crypto_secretbox_MACBYTES
    crypto_secretbox_easy: typeof crypto_secretbox_easy
    crypto_secretbox_open_easy: typeof crypto_secretbox_open_easy
  }
  export default sodium
}

declare module 'bare-subprocess/parent' {
  export default class ParentChannel {
    readonly connected: boolean
    on(event: 'message', handler: (message: unknown, handle?: unknown) => void): this
    on(event: 'disconnect', handler: () => void): this
    on(event: 'error', handler: (error: Error) => void): this
    send(message: unknown, handle?: unknown, callback?: (error?: Error | null) => void): boolean
    disconnect(): void
    ref(): void
    unref(): void
  }
}
