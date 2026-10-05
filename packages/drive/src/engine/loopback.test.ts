import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SenderSession } from './sender'
import { ReceiverSession } from './receiver'
import { selectChunkSize, chunkCount, chunkRange } from './chunker'
import { MAX_TRANSFER_SIZE_BYTES, NEED_BATCH_CHUNKS } from './constants'
import { DiskReader } from '../adapters/disk-reader'
import { DiskWriter } from '../adapters/disk-writer'
import { createChannelPair } from '../../test/support'
import type { ChunkHeader, ChunkReader, ChunkWriter, ControlMessage, DriveChannel, NeedMessage } from './types'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drive-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function pseudoRandom(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed >>> 0
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = x & 0xff
  }
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

async function waitUntil(fn: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  }
  throw new Error('waitUntil: condition never held')
}

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i < end; i++) out.push(i)
  return out
}

async function readOut(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

function frames(input: Uint8Array, transferId: string) {
  const chunkSize = selectChunkSize(input.length)
  const total = chunkCount(input.length, chunkSize)
  const list: Array<{ header: ChunkHeader; data: Uint8Array }> = []
  for (let i = 0; i < total; i++) {
    const { offset, length } = chunkRange(i, input.length, chunkSize)
    const data = input.slice(offset, offset + length)
    list.push({ header: { transferId, index: i }, data })
  }
  return { chunkSize, total, list }
}

function controlledChannel() {
  let messageHandler: ((m: ControlMessage) => void) | undefined
  let chunkHandler: ((h: ChunkHeader, d: Uint8Array) => void) | undefined
  const sent: ControlMessage[] = []
  const channel: DriveChannel = {
    send: (m) => sent.push(m),
    sendChunk: () => {},
    onMessage: (h) => (messageHandler = h),
    onChunk: (h) => (chunkHandler = h),
    bufferedAmount: () => 0,
    close: () => {}
  }
  return {
    channel,
    sent,
    deliverMessage: (m: ControlMessage) => messageHandler?.(m),
    deliverChunk: (h: ChunkHeader, d: Uint8Array) => chunkHandler?.(h, d)
  }
}

const CHUNK_64K = 64 * 1024

describe('full sender ↔ receiver loopback', () => {
  const sizes = [0, 1, 100, CHUNK_64K, CHUNK_64K + 1, 200 * 1024]

  for (const size of sizes) {
    it(`round-trips a ${size}-byte file`, async () => {
      const input = pseudoRandom(size)
      const src = join(dir, 'src.bin')
      const dst = join(dir, 'dst.bin')
      await writeFile(src, input)

      const [senderChannel, receiverChannel] = createChannelPair()
      const receiver = new ReceiverSession(new DiskWriter(dst), receiverChannel, {
        transferId: 't'
      })
      const sender = new SenderSession(new DiskReader(src), senderChannel, {
        transferId: 't',
        name: 'file.bin'
      })

      const [savedTo] = await Promise.all([receiver.receive(), sender.start()])
      await sender.close()

      expect(savedTo).toBe(dst)
      expect(sameBytes(await readOut(dst), input)).toBe(true)
    })
  }

  it('round-trips files that require multiple bounded need batches', async () => {
    const input = pseudoRandom(5 * 1024 * 1024)
    const src = join(dir, 'src-batched.bin')
    const dst = join(dir, 'dst-batched.bin')
    await writeFile(src, input)

    const [senderChannel, receiverChannel] = createChannelPair()
    const receiver = new ReceiverSession(new DiskWriter(dst), receiverChannel, { transferId: 't' })
    const sender = new SenderSession(new DiskReader(src), senderChannel, {
      transferId: 't',
      name: 'file.bin'
    })

    const [savedTo] = await Promise.all([receiver.receive(), sender.start()])
    await sender.close()

    expect(chunkCount(input.length, selectChunkSize(input.length))).toBeGreaterThan(NEED_BATCH_CHUNKS)
    expect(savedTo).toBe(dst)
    expect(sameBytes(await readOut(dst), input)).toBe(true)
  })

  it('reports progress up to the full size', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    const dst = join(dir, 'dst.bin')
    await writeFile(src, input)

    const [senderChannel, receiverChannel] = createChannelPair()
    let lastReceived = 0
    const receiver = new ReceiverSession(new DiskWriter(dst), receiverChannel, {
      transferId: 't',
      onProgress: (bytes) => (lastReceived = bytes)
    })
    const sender = new SenderSession(new DiskReader(src), senderChannel, {
      transferId: 't',
      name: 'file.bin'
    })

    await Promise.all([receiver.receive(), sender.start()])
    await sender.close()
    expect(lastReceived).toBe(input.length)
  })

  it('reports progress on an interval when the byte step is never reached', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    const dst = join(dir, 'dst.bin')
    await writeFile(src, input)

    const [senderChannel, receiverChannel] = createChannelPair()
    const progress: number[] = []
    const receiver = new ReceiverSession(new DiskWriter(dst), receiverChannel, {
      transferId: 't',
      progressStepBytes: Number.MAX_SAFE_INTEGER,
      progressIntervalMs: 0,
      onProgress: (bytes) => progress.push(bytes)
    })
    const sender = new SenderSession(new DiskReader(src), senderChannel, {
      transferId: 't',
      name: 'file.bin'
    })

    await Promise.all([receiver.receive(), sender.start()])
    await sender.close()

    expect(progress.length).toBeGreaterThan(1)
    expect(progress).toStrictEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(input.length)
  })

  it('reports absolute progress when the peer only needs the tail', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)

    const { channel, sent, deliverMessage } = controlledChannel()
    const progress: number[] = []
    const sender = new SenderSession(new DiskReader(src), channel, {
      transferId: 't',
      name: 'file.bin',
      onProgress: (bytes) => progress.push(bytes)
    })
    sender.start().catch((err) => console.error('test setup failed', err))
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    const total = chunkCount(input.length, CHUNK_64K)
    deliverMessage({ type: 'need', transferId: 't', indices: [total - 1] })
    await waitUntil(() => progress.length > 0)
    await sender.close()

    expect(progress.at(-1)).toBe(input.length)
  })
})

describe('receiver robustness', () => {
  it('reconstructs the file from out-of-order chunks', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list } = frames(input, 't')
    const { channel, sent, deliverMessage, deliverChunk } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    for (const { header, data } of [...list].reverse()) deliverChunk(header, data)
    deliverMessage({ type: 'complete', transferId: 't' })

    await done
    expect(sameBytes(await readOut(dst), input)).toBe(true)
    expect(sent.some((m) => m.type === 'ack')).toBe(true)
  })

  it('rejects a non-integer chunk index', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list } = frames(input, 't')
    const { channel, deliverMessage, deliverChunk } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    deliverChunk({ ...list[0].header, index: 1.5 }, list[0].data)

    await expect(done).rejects.toThrow(/out of range/)
  })

  it('tells the peer to cancel when it fails locally', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list } = frames(input, 't')
    const { channel, sent, deliverMessage, deliverChunk } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    deliverChunk(list[0].header, list[0].data.slice(0, 8))

    await expect(done).rejects.toThrow(/length/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('does not echo a cancel back to the peer that sent it', async () => {
    const dst = join(dir, 'dst.bin')
    const { channel, sent, deliverMessage } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: 200 * 1024,
      chunkSize: CHUNK_64K
    })
    deliverMessage({ type: 'cancel', transferId: 't', reason: 'peer went away' })

    await expect(done).rejects.toThrow(/peer went away/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(false)
  })

  it('rejects a chunk whose length does not match its slot', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list } = frames(input, 't')
    const { channel, deliverMessage, deliverChunk } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    deliverChunk(list[0].header, list[0].data.slice(0, 8))

    await expect(done).rejects.toThrow(/length/)
    await expect(stat(dst)).rejects.toThrow()
  })

  it('rejects a chunk whose length is wrong', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list } = frames(input, 't')
    const { channel, deliverMessage, deliverChunk } = controlledChannel()

    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    deliverChunk(list[0].header, list[0].data.subarray(0, 10))

    await expect(done).rejects.toThrow(/length/)
  })
})

describe('receiver finalization arbitration', () => {
  it('does not let a late cancel turn an in-flight commit into failure', async () => {
    const { channel, sent, deliverMessage } = controlledChannel()
    let releaseCommit!: (savedTo: string) => void
    let commitStarted = false
    let abortCalls = 0
    const commitResult = new Promise<string>((resolve) => { releaseCommit = resolve })
    const writer: ChunkWriter = {
      allocate: async () => {},
      write: async () => {},
      prepareFinalize: async () => {},
      commitFinalize: async () => {
        commitStarted = true
        return await commitResult
      },
      finalize: async () => await commitResult,
      abort: async () => { abortCalls++ }
    }
    const receiver = new ReceiverSession(writer, channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'empty.bin',
      size: 0,
      chunkSize: selectChunkSize(0)
    })
    deliverMessage({ type: 'complete', transferId: 't' })
    await waitUntil(() => commitStarted)

    receiver.cancel('too late')
    releaseCommit('/saved/empty.bin')

    await expect(done).resolves.toBe('/saved/empty.bin')
    expect(abortCalls).toBe(0)
    expect(sent).toContainEqual({ type: 'ack', transferId: 't', savedTo: '/saved/empty.bin' })
  })
})

describe('resume', () => {
  it('requests only the missing chunks on the second run', async () => {
    const input = pseudoRandom(200 * 1024)
    const dst = join(dir, 'dst.bin')
    const { list, total } = frames(input, 't')

    const first = controlledChannel()
    const writer1 = new DiskWriter(dst)
    const receiver1 = new ReceiverSession(writer1, first.channel, { transferId: 't' })
    const firstDone = receiver1.receive()
    firstDone.catch(() => {})
    first.deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    first.deliverChunk(list[0].header, list[0].data)
    first.deliverChunk(list[1].header, list[1].data)
    await waitUntil(() => (receiver1.received?.count() ?? 0) === 2)

    const resumeBits = receiver1.received!.serialize().slice()

    // Simulate a real pause/reconnect: the resumable bitmap belongs to the
    // exact partial file created by the first writer. Closing the first writer
    // keeps that owned partial on disk, matching the production resume path.
    receiver1.cancel('test pause')
    await expect(firstDone).rejects.toThrow(/test pause/)

    const second = controlledChannel()
    const receiver2 = new ReceiverSession(
      new DiskWriter(dst, { partPath: writer1.partPath, resume: true }),
      second.channel,
      {
        transferId: 't',
        resumeBits
      }
    )
    const done = receiver2.receive()
    second.deliverMessage({
      type: 'start',
      transferId: 't',
      name: 'f',
      size: input.length,
      chunkSize: CHUNK_64K
    })
    await waitUntil(() => second.sent.some((m) => m.type === 'need'))

    const need = second.sent.find((m): m is NeedMessage => m.type === 'need')!
    expect(need.indices).toEqual(range(2, total))

    for (let i = 2; i < total; i++) second.deliverChunk(list[i].header, list[i].data)
    second.deliverMessage({ type: 'complete', transferId: 't' })

    await done
    expect(sameBytes(await readOut(dst), input)).toBe(true)
  })
})

describe('hostile input', () => {
  it('receiver rejects a start whose chunkSize is inconsistent with size', async () => {
    const dst = join(dir, 'dst.bin')
    const { channel, sent, deliverMessage } = controlledChannel()
    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()

    deliverMessage({ type: 'start', transferId: 't', name: 'f', size: 200 * 1024, chunkSize: 1 })

    await expect(done).rejects.toThrow(/geometry/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('receiver bounds queued control frames while earlier work is stalled', async () => {
    const dst = join(dir, 'dst.bin')
    const { channel, sent, deliverMessage } = controlledChannel()
    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()
    const size = 4096
    const chunkSize = selectChunkSize(size)

    // Delivery is synchronous while execution is serialized through the
    // receiver promise tail. More than the bounded control window must fail
    // instead of retaining an unbounded chain of closures/messages.
    for (let i = 0; i < NEED_BATCH_CHUNKS * 4 + 1; i++) {
      deliverMessage({ type: 'start', transferId: 't', name: 'f', size, chunkSize })
    }

    await expect(done).rejects.toThrow(/control queue exceeded/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('receiver rejects a peer-controlled transfer larger than the hard ceiling', async () => {
    const dst = join(dir, 'dst.bin')
    const { channel, sent, deliverMessage } = controlledChannel()
    const receiver = new ReceiverSession(new DiskWriter(dst), channel, { transferId: 't' })
    const done = receiver.receive()
    const size = MAX_TRANSFER_SIZE_BYTES + 1

    deliverMessage({ type: 'start', transferId: 't', name: 'f', size, chunkSize: selectChunkSize(size) })

    await expect(done).rejects.toThrow(/geometry/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('sender rejects a need with an out-of-range index', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)
    const { total } = frames(input, 't')

    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(new DiskReader(src), channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: [total + 5] })

    await expect(done).rejects.toThrow(/Rejected/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
    await sender.close()
  })

  it('sender rejects a need larger than the protocol credit window', async () => {
    const input = pseudoRandom(4 * 1024 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)

    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(new DiskReader(src), channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({
      type: 'need',
      transferId: 't',
      indices: Array.from({ length: NEED_BATCH_CHUNKS + 1 }, (_, index) => index)
    })

    await expect(done).rejects.toThrow(/Rejected/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
    await sender.close()
  })

  it('sender rejects a need with duplicate indices', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)

    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(new DiskReader(src), channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: [0, 0] })

    await expect(done).rejects.toThrow(/Rejected/)
    await sender.close()
  })
})

describe('overlapping need control', () => {
  it('queues a second need that arrives while the first batch is still reading', async () => {
    // Exactly two chunks: this test exercises overlapping credit, while the
    // terminal ACK remains valid after both credited chunks are complete.
    const input = pseudoRandom(100 * 1024)
    let firstReadStarted!: () => void
    let releaseFirst!: () => void
    const started = new Promise<void>((resolve) => { firstReadStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseFirst = resolve })
    let first = true
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => {
        if (first) {
          first = false
          firstReadStarted()
          await release
        }
        return input.slice(offset, offset + length)
      },
      close: async () => {}
    }
    const sent: ControlMessage[] = []
    const sentChunks: number[] = []
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: (header) => sentChunks.push(header.index),
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    msgHandler!({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })
    await started
    msgHandler!({ type: 'need', transferId: 't', indices: [1], receivedBytes: 0 })
    releaseFirst()

    await waitUntil(() => sentChunks.length === 2)
    expect(sentChunks).toEqual([0, 1])
    // sendChunk() happens before SenderSession publishes `complete` and
    // transitions to awaiting-ack. Wait for the second batch boundary so
    // this test cannot manufacture an early ACK race.
    await waitUntil(() => sent.filter((m) => m.type === 'complete').length === 2)
    msgHandler!({ type: 'ack', transferId: 't', savedTo: 'ok' })
    await expect(done).resolves.toBe('ok')
    await sender.close()
  })

  it('rejects aggregate credits beyond the protocol window while a batch is active', async () => {
    const input = pseudoRandom(5 * 1024 * 1024)
    let releaseRead!: () => void
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseRead = resolve })
    let first = true
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => {
        if (first) {
          first = false
          readStarted()
          await release
        }
        return input.slice(offset, offset + length)
      },
      close: async () => {}
    }
    const sent: ControlMessage[] = []
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    msgHandler!({ type: 'need', transferId: 't', indices: range(0, NEED_BATCH_CHUNKS), receivedBytes: 0 })
    await started
    msgHandler!({ type: 'need', transferId: 't', indices: [NEED_BATCH_CHUNKS], receivedBytes: 0 })

    await expect(done).rejects.toThrow(/credit window/)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
    releaseRead()
    await sender.close()
  })

  it('coalesces a repeated need for the batch already in flight', async () => {
    const input = pseudoRandom(100)
    let releaseRead!: () => void
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseRead = resolve })
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => {
        readStarted()
        await release
        return input.slice(offset, offset + length)
      },
      close: async () => {}
    }
    const sent: ControlMessage[] = []
    const sentChunks: number[] = []
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: (header) => sentChunks.push(header.index),
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    msgHandler!({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })
    await started
    msgHandler!({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })
    releaseRead()

    await waitUntil(() => sent.some((m) => m.type === 'complete'))
    expect(sentChunks).toEqual([0])
    expect(sent.filter((m) => m.type === 'complete')).toHaveLength(1)
    msgHandler!({ type: 'ack', transferId: 't', savedTo: 'ok' })
    await expect(done).resolves.toBe('ok')
    await sender.close()
  })

  it('rejects an ack before any credited batch completed', async () => {
    const input = pseudoRandom(100)
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => input.slice(offset, offset + length),
      close: async () => {}
    }
    const { channel, sent, deliverMessage } = controlledChannel()
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    deliverMessage({ type: 'ack', transferId: 't', savedTo: 'forged' })

    await expect(done).rejects.toThrow(/ack before sender completed/i)
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
    await sender.close()
  })

  it('does not let a duplicate served need keep the sender watchdog alive', async () => {
    const input = pseudoRandom(100)
    const sentChunks: number[] = []
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: (header) => sentChunks.push(header.index),
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => input.slice(offset, offset + length),
      close: async () => {}
    }
    const sender = new SenderSession(reader, channel, {
      transferId: 't',
      name: 'f',
      ackTimeoutMs: 30
    })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })
    await waitUntil(() => sent.some((m) => m.type === 'complete'))

    const spam = setInterval(() => {
      msgHandler?.({ type: 'need', transferId: 't', indices: [0], receivedBytes: input.length })
    }, 5)
    try {
      await expect(done).rejects.toThrow(/silent/)
    } finally {
      clearInterval(spam)
      await sender.close()
    }
    expect(sentChunks).toEqual([0])
  })

  it('rejects an ack after a non-terminal credit batch', async () => {
    const input = pseudoRandom(200_000)
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => input.slice(offset, offset + length),
      close: async () => {}
    }
    const { channel, sent, deliverMessage } = controlledChannel()
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))

    deliverMessage({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })
    await waitUntil(() => sent.some((m) => m.type === 'complete'))
    deliverMessage({ type: 'ack', transferId: 't', savedTo: 'forged' })

    await expect(done).rejects.toThrow(/ack before sender completed/i)
    await sender.close()
  })

  it('does not let repeated empty need frames keep the sender watchdog alive', async () => {
    const input = pseudoRandom(100)
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => input.slice(offset, offset + length),
      close: async () => {}
    }
    const sender = new SenderSession(reader, channel, {
      transferId: 't',
      name: 'f',
      ackTimeoutMs: 80
    })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: [], receivedBytes: 0 })
    await waitUntil(() => sent.some((m) => m.type === 'complete'))

    const spam = setInterval(() => {
      msgHandler?.({ type: 'need', transferId: 't', indices: [], receivedBytes: 0 })
    }, 5)
    try {
      await expect(done).rejects.toThrow(/silent/)
    } finally {
      clearInterval(spam)
      await sender.close()
    }
    expect(sent.filter((m) => m.type === 'complete')).toHaveLength(1)
  })

  it('accepts a synchronous ack emitted in response to complete', async () => {
    const input = pseudoRandom(100)
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const sent: ControlMessage[] = []
    const channel: DriveChannel = {
      send: (m) => {
        sent.push(m)
        if (m.type === 'complete') msgHandler?.({ type: 'ack', transferId: 't', savedTo: 'ok' })
      },
      sendChunk: () => {},
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const reader: ChunkReader = {
      size: async () => input.length,
      read: async (offset, length) => input.slice(offset, offset + length),
      close: async () => {}
    }
    const sender = new SenderSession(reader, channel, { transferId: 't', name: 'f' })
    const done = sender.start()
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: [0], receivedBytes: 0 })

    await expect(done).resolves.toBe('ok')
    await sender.close()
  })

  it('times out when the receiver never answers start', async () => {
    const reader: ChunkReader = {
      size: async () => 1,
      read: async () => new Uint8Array([1]),
      close: async () => {}
    }
    const channel: DriveChannel = {
      send: () => {},
      sendChunk: () => {},
      onMessage: () => {},
      onChunk: () => {},
      bufferedAmount: () => 0,
      close: () => {}
    }
    const sender = new SenderSession(reader, channel, {
      transferId: 't',
      name: 'f',
      ackTimeoutMs: 20
    })

    await expect(sender.start()).rejects.toThrow(/silent/)
    await sender.close()
  })
})

describe('chunk reads', () => {
  it('a full send reads each chunk exactly once', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)
    const { total } = frames(input, 't')

    const disk = new DiskReader(src)
    let reads = 0
    const counting: ChunkReader = {
      size: () => disk.size(),
      read: (offset, length) => {
        reads++
        return disk.read(offset, length)
      },
      close: () => disk.close()
    }

    const { channel, sent, deliverMessage } = controlledChannel()
    const sender = new SenderSession(counting, channel, { transferId: 't', name: 'f' })
    sender.start().catch((err) => console.error('test setup failed', err))
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    deliverMessage({ type: 'need', transferId: 't', indices: range(0, total) })
    await waitUntil(() => sent.some((m) => m.type === 'complete'))

    expect(reads).toBe(total)
  })
})

describe('sender backpressure', () => {
  it('holds off while the transport is full and resumes when it drains', async () => {
    const input = pseudoRandom(200 * 1024)
    const src = join(dir, 'src.bin')
    await writeFile(src, input)
    const { total } = frames(input, 't')

    let full = true
    let release!: () => void
    const writable = new Promise<void>((resolve) => {
      release = resolve
    })

    const sent: ControlMessage[] = []
    const sentChunks: number[] = []
    let msgHandler: ((m: ControlMessage) => void) | undefined
    const channel: DriveChannel = {
      send: (m) => sent.push(m),
      sendChunk: (header) => sentChunks.push(header.index),
      onMessage: (h) => (msgHandler = h),
      onChunk: () => {},
      bufferedAmount: () => (full ? 64 * 1024 * 1024 : 0),
      whenWritable: () => writable,
      close: () => {}
    }

    const sender = new SenderSession(new DiskReader(src), channel, { transferId: 't', name: 'f' })
    sender.start().catch((err) => console.error('test setup failed', err))
    await waitUntil(() => sent.some((m) => m.type === 'start'))
    msgHandler!({ type: 'need', transferId: 't', indices: range(0, total) })

    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    expect(sentChunks).toEqual([])

    full = false
    release()
    await waitUntil(() => sentChunks.length === total)
    await sender.close()

    expect(sentChunks.length).toBe(total)
  })
})
