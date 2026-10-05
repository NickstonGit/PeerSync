# @peersync/core

`@peersync/core` is the standalone networking and synchronization core used by
PeerSync. It runs inside `PSNCore.exe` on Bare and owns peer discovery,
authenticated peer sessions, remembered-device pairing, file-operation RPC,
chat, relay fallback and application-update transport.

The package is intentionally UI-independent. The Python/Tk shell in
`apps/portable-python` communicates with the Core through bounded framed JSON
IPC; user file bytes move between peers through `@peersync/drive`.

## Runtime shape

```text
PeerSync Python/Tk shell
        |
        | framed JSON IPC / Named Pipes
        v
PSNCore.exe
  packages/core/src/portable
        |
        +-- remembered-device discovery / pairing
        +-- fs.v1 request channel
        +-- chat channel
        +-- update channel
        +-- @peersync/drive chunk transport
        +-- relay fallback
```

The production entry point is `src/portable/entry.ts`. `tsup` produces the
portable JavaScript bundle, and the Windows build then packages it into the
standalone Bare executable used by the shell.

## Main areas

- `src/portable/` — production IPC entry point, peer manager, filesystem engine,
  roots, manifests, journals, recovery, chat and update handling.
- `src/worklet/identity/` — device identity state and validation.
- `src/worklet/peers/` — pairing, remembered peers, rendezvous and discovery.
- `src/worklet/relay/` — relay configuration and relay transport support.
- `src/worklet/transfer/` — peer control and `@peersync/drive` integration.
- `schema/spec/hyperdb/` — remembered-peer HyperDB definition.

## Compatibility identifiers

Some transport and persisted-state byte strings are intentionally stable across
PeerSync releases. They are centralized in `src/transport-compat.ts`; changing
them is a protocol/state migration, not a branding change. Project provenance
and required upstream attribution are documented in the repository `NOTICE`.

## Building

From the repository root:

```sh
npm run build -w packages/drive
npm run build -w packages/core
```

For the complete Windows artifact, use `scripts/build-portable-win.ps1` rather
than invoking this package directly.

## Testing

```sh
npm test -w packages/core
npm run typecheck -w packages/core
```

The repository CI additionally exercises the frozen GUI/Core startup, direct
transfer, kill/resume recovery, actual relay transfer, discovery/reconnect and
artifact reproducibility gates.

## License

Apache-2.0. See the repository `NOTICE` for transport provenance and retained
attribution.
