# Architecture

PeerSync by Nickston is a portable Windows application built as a Python/Tk two-panel shell (`apps/portable-python`) talking over framed Named Pipe IPC to a standalone Bare Core (`packages/core/src/portable`). P2P networking stays outside the UI process.

## Transport compatibility and provenance

PeerSync owns the application surface, local state model, IPC, file-operation engine, recovery and release pipeline. Its P2P transport layer began from an Apache-2.0 upstream transport and has been substantially adapted for PeerSync; provenance is recorded in the repository `NOTICE`.

Several exact wire/cryptographic/storage identifiers predate the current product branding. They are centralized in `packages/core/src/transport-compat.ts` and `apps/portable-python/runtime/compat.py`. These are compatibility bytes used by existing PeerSync data and peer sessions, not public product names. Changing them requires an explicit protocol or persisted-state migration.

## Repository layout

```
apps/
  portable-python/  Windows portable shell — Tk two-panel UI + Named Pipe IPC
packages/
  core/             P2P protocol — Hyperswarm, transfer orchestration, device pairing, RPC
  drive/            Chunked file transfer — fixed chunks, pread/pwrite, resume
```

## Portable Windows data flow

```
Python/Tk shell (apps/portable-python)
        │ framed JSON RPC, 1 MiB shell frame cap
        ▼
PSNCore.exe / Bare portable core
(packages/core/src/portable)
        │ remembered-peer Hyperswarm + bounded drive channels
        ▼
Peer compatible Core
```

The shell owns UI, DPAPI-backed local identity material, update UX, diagnostics storage, and process lifecycle. The portable Core owns roots, manifests, durable transfer journals, pairing/discovery, and P2P transfer state. File writes are finalized only after receiver hashing and the portable overwrite state machine.

Recovery is scoped below the peer transport. Operation RPC timeouts, source verification, journal errors, and finalize errors update the operation journal without destroying a healthy peer session. Source verification runs as a deduplicated background job; durable recovery attempts use backoff and a finite circuit breaker. Reconnect backoff is transport-only.

With `--debug`, the shell writes structured diagnostics to a bounded JSONL recorder and exposes one authenticated read-only local Named Pipe. The external MCP adapter lives outside the product tree and reads the endpoint descriptor automatically.

## Packages

### `packages/core`

> **Two runtimes, one shipped.** The portable product is built from
> `src/portable/entry.ts` → `PortableCore` (`build-portable-win.ps1` emits only
> `dist/portable/entry.js`). The `worklet/` tree below is the **upstream
> worklet entry** and is *not* on the portable data path — `PortableCore` never
> imports `worklet/index.ts` or `TransferOrchestrator`. It is kept because the
> portable shell still reuses `worklet/transfer/drive`, `swarm`, `peers/*`,
> `relay/*` and `identity/*`, and because `@peersync/drive` still exports
> `DiskWriter` as a package-level API. Read the portable graph below first when
> auditing what actually ships.

#### Portable graph (shipped)

- `portable/entry.ts` — production entrypoint: framed JSON IPC on stdio → `PortableCore`
- `portable/portable-core.ts` — composition root: roots, journals, peers, chat, `FsEngine`
- `portable/fs-engine.ts` — the fs.v1 protocol state machine. Contains the only
  transfer writer on the shipped path: `ReceiverWriter`
- `portable/pathguard.ts` — the single path resolver for every filesystem op, both peers
- `portable/journal.ts` — encrypted, atomically written operation journals; the durable
  record behind crash recovery
- `portable/root-fs-executor.ts` — bounded pool of disposable OS worker processes, so a
  blocked SMB/UNC syscall stays cancellable
- `portable/peers.ts` — `PeerManager`; reuses `worklet/transfer/drive` for chunk channels

#### Worklet graph (upstream, not shipped)

The protocol layer, running entirely inside a **Bare worklet** (a lightweight JS runtime spawned by the host) so P2P networking is isolated from the UI process.

- `worklet/index.ts` — entrypoint; wires Bare IPC → RPC server → orchestrator
- `worklet/transfer/orchestrator.ts` — top-level coordinator; owns session lifecycle + state, composes the subsystems below
- `worklet/transfer/swarm.ts` — `TransferSwarm`: peer connectivity, per-peer control channels
- `worklet/transfer/drive.ts` — the `@peersync/drive` chunk channel over Protomux; the only transfer path
- `worklet/transfer/control-channel.ts` — per-peer control messages (offers, requests, progress, cancel)
- `worklet/transfer/sender.ts` / `receiver.ts` — sender describes files on disk and serves chunks from them; receiver opens a drive channel per file and writes chunks straight to the target
- `worklet/transfer/topic-auth.ts` — the join-code proof (see [Topic authentication](#topic-authentication))
- `worklet/relay/config.ts` / `conf.ts` — relay state + `relayThrough`; relay list from a signed DHT record (see [Relay fallback](#relay-fallback))
- `worklet/relay/announce.ts` / `upgradeWebRelay.ts` — present a signed cap token to a relay (see [Relay fallback](#relay-fallback))
- `worklet/identity/device-identity-store.ts` — the stable device keypair, sealed in the OS keychain (see [Pairing](#remembered-devices--pairing))
- `worklet/peers/*` — `RememberedPeerStore`, `PairingCoordinator`, `DiscoveryCoordinator`, `RecognitionCoordinator`, `RememberCoordinator`
- `worklet/rpc/*` — RPC server + canonical command/reply protocol; `client/worker-client.ts` is the host-side typed client

### `packages/drive`

The chunked file-transfer engine, independent of Hyperswarm and Hyperdrive. The sender `pread`s fixed-size chunks and the receiver `pwrite`s them at their offset, so neither side keeps a second copy on disk; a resume bitmap picks up an interrupted transfer where it stopped.

It runs over a caller-supplied `DriveChannel` rather than owning a socket (core supplies a Protomux channel today), so it stays transport-agnostic. `DiskReader` / `DiskWriter` are the Bare adapters; the root export is fs-free so the engine also runs in a browser. Wire protocol: `packages/drive/README.md`.

`DiskWriter` is a supported package-level API (`native.ts` re-exports it, `drive.test.ts`
covers it), **not** dead code — but it is not the writer on the portable path. That path
uses `ReceiverWriter` in `portable/fs-engine.ts`.

#### Publication rules shared by every writer

Naming and ownership must not drift between writers, so the rules live in one place
(`packages/drive/src/adapters/publication.ts`) and both `ReceiverWriter` and `DiskWriter`
build on it:

- `claimFreeName` walks the no-replace candidate sequence: the target, then
  `base (1)`, `base (2)`, … up to `PUBLICATION_CANDIDATE_LIMIT`. The first
  suffixed sibling is `(1)`; a gap there silently skips a free name.
- `statIdentity` serializes `dev:ino:birthtimeMs:mode` as a **string**. Inode values
  exceed the JS safe-integer range and every durable record is JSON, so numbers
  would be corrupted before they could be compared after a restart.
- A writer records the destination's object identity **before** the final pathname
  becomes visible (before `link`, and before the first byte of an exclusive copy).
  That is what lets crash recovery prove a leftover short copy is ours instead of
  parking the operation for the user to resolve by hand.

Two ownership backends sit above that shared core: the portable path journals to the
encrypted `JournalStore`; `DiskWriter` writes a `.meta` sidecar.

## Transfer flow

1. **Sender** opens the share screen → the worklet generates a single-use topic: a random 32-byte key, hex-encoded to a 64-char join code.
2. **Receiver** types or receives the code → core validates and extracts the topic, passes it to the worklet.
3. Both sides join the Hyperswarm topic; on connection they open control and drive channels over the noise-encrypted socket.
4. **Topic authentication** — the sender challenges the receiver to prove it holds the join code before releasing any offers; a wrong proof is rejected, while a peer that never proves it is flagged (not dropped). See [Topic authentication](#topic-authentication).
5. Sender broadcasts a `transfer-ready` message with file offers.
6. Receiver requests each file over a `@peersync/drive` chunk channel, streaming chunks straight to disk. Progress flows back over the control channel → RPC → portable UI.

A legacy peer that does not speak the drive protocol fails the transfer with a protocol-support error. New transfer work belongs in `packages/drive`.

A transfer is capped at **10,000 files** (`MAX_FILES_PER_TRANSFER`, validated in `control-validation.ts`); the send UI blocks earlier with a "zip them" hint. The whole offer list goes in one message on the single worklet thread, so huge counts would choke it.

## Topic authentication

The DHT **discovery topic** is only a hash — observable on the network. Knowing it must not be enough to receive files; a peer has to prove it holds the actual **join code**.

The sender sends a random `challenge` nonce; the receiver must reply with `topicProof(joinCode, nonce)` — a BLAKE2b hash of the code + nonce (`worklet/transfer/topic-auth.ts`). The join code never crosses the wire.

A valid proof releases the offers (even if late) and is required to serve a file — `serve()` refuses a download request from an unauthenticated peer, so reaching the topic is not enough even if a file id leaks. A wrong proof drops the connection. A peer silent past 10 s isn't dropped — it's flagged **"Update to connect"** (`peer-unauthenticated`) and can still auth late (`peer-authenticated` clears it), so a busy sender never aborts a legit receiver. Receiving from an older sender is unaffected — a receiver only answers a challenge, never requires one.

## Relay fallback

Most transfers connect directly via hole-punching. When two peers can't reach each other — typically both behind symmetric NAT (e.g. both on a VPN) — the transfer falls back to a **blind relay**: a public server that pairs the peers and forwards their already-encrypted UDX stream, never holding the keys to decrypt it.

- **Engagement** — `relay/config.ts` exposes `relayThrough` in "eager" mode: when enabled it always offers the relay, so hyperdht races a relayed path against a direct punch and upgrades to direct if the punch lands.
- **Discovery** — the relay key isn't baked in. `relay/conf.ts` reads the relay list from a signed DHT **mutable record** (public key injected at build via `--relay-conf-pubkey`), so relays rotate with no app release. Fetched lazily once the relay is enabled, with bounded retry (the worklet keeps no persistent core storage, so a hypercore won't do).
- **Classification** — `TransferSwarm.classifyConnection` matches a peer's `remoteHost` against known relay hosts and emits a per-peer `connection-type` (`direct` / `relay`), keyed per sender; the UI shows **Connected** vs **Connected via relay**.
- **Caps** — a relay caps how much a session forwards. A sender raises its own cap with a short-lived token signed by the entitlement service and verified against the relay's public key: `relay/announce.ts` sends it over the legacy relay-compatibility channel defined by `RELAY_PROTOCOL`, and `config.ts` releases it only while sending and only to a key from the signed relay list. Enforced relay-side.

The app is only ever a relay _client_ — it holds the relay's public key and address, never a secret.

## Remembered devices & pairing

You can **pair** devices you trust to send to them later without a code. This lives in the worklet (`peers/*` + `identity/`) across three Hyperswarm instances:

| Swarm                                  | Lifetime        | Transport key           | Purpose                                          |
| -------------------------------------- | --------------- | ----------------------- | ------------------------------------------------ |
| **Transfer** (`TransferSwarm`)         | per session     | fresh per-topic keypair | the file transfer (join-code flow above)         |
| **Pairing** (`PairingCoordinator`)     | per app session | per-topic keypair       | the QR / code pairing handshake                  |
| **Discovery** (`DiscoveryCoordinator`) | persistent      | the **device keypair**  | background links to remembered devices + invites |

- **Device identity** — each install has a stable Ed25519 keypair (`DeviceIdentityStore`); the secret is sealed in the OS keychain (Windows DPAPI on the portable surface) and injected at startup, only the public key persists.
- **Pairing** — the QR opens a pairing swarm on a fresh topic; both sides exchange a signed `pairing-info` (pubkey + name, signed over the noise handshake so it can't be relayed) and vote to remember each other, deriving a shared rendezvous topic. A live transfer peer can pair via the "Pair" button (`RememberCoordinator`).
- **Discovery & invites** — the discovery swarm uses the device keypair, firewalled to remembered pubkeys, keeping background links to paired devices. To send without a code you "invite" one: the worklet joins its rendezvous topic and sends an invite it can accept.
- **Recognition (privacy)** — to badge an already-paired peer without revealing identity, each side sends only a **signature** over the handshake (no pubkey/name); the receiver matches it against its own remembered devices. A non-paired peer learns nothing.
- **Persistence** — a transfer keeps nothing on disk beyond the file being written; device identity and the remembered-peer list persist.

## IPC bridge (portable)

```
Python/Tk shell (apps/portable-python)
        │ framed JSON RPC over Named Pipe
        ▼
PSNCore.exe (packages/core/src/portable) — standalone Bare runtime
```

All IPC messages are typed via `packages/core/src/worklet/rpc/protocol.ts`.
