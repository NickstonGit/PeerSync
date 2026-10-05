# PeerSync by Nickston — IPC protocol v1

Владелец: shell (Python/Tk) = родитель; Core (`PSNCore.exe`, Bare) = ребёнок.
Core хранит identity в памяти из `hello` (DPAPI у shell), roots/journal/chat — в
`dataRoot`, заданном shell; ядро не читает пользовательские файлы вне registered roots.

## 1. Transport (framing)

- stdin/stdout ребёнка зарезервированы под протокол. Фрейм: `uint32_le` длина +
  UTF-8 JSON, cap **1 MiB** в обе стороны. stderr — логи.
- Windows: shell создаёт именованные pipe-пары (bare-pipe несовместим с анонимными
  stdio), ребёнок получает inherited overlapped концы на 0/1.
- stdin EOF/error → Core `exit 0/1` без orphan; `type:"shutdown"` или `app.shutdown`
  → graceful: journal checkpoint → exit 0.

## 1.1 Diagnostics

- Python-shell владеет `data/logs/diagnostics.jsonl`, `last-snapshot.json` и rotating legacy sinks.
- Без `--debug` порог recorder — `ERROR`; записываются только `ERROR` и `CRITICAL`.
- С `--debug` записываются `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`, а shell поднимает локальный diagnostics pipe.
- Core пишет structured JSONL только в stderr; stdout остаётся framed IPC.
- При `--debug` descriptor `data/runtime/diagnostics-endpoint.json` содержит `pipeName`, PID, `startedAtMs`, `coreEpoch` и capability token.
- Pipe использует owner-only ACL, `PIPE_REJECT_REMOTE_CLIENTS`, framing `uint32_le + UTF-8 JSON` и единственный read-only метод `diagnostics.snapshot`.
- Snapshot возвращает runtime/core status, bounded counters и последние redacted events; token и абсолютные пути не возвращаются.
- Внешний MCP live/offline клиент находится вне product tree и получает token автоматически из descriptor.

## 2. Envelope (IPC shell↔Core)

```
{"type":"request","requestId":"<uuid>","method":"<name>","payload":{…}}
{"type":"response","requestId":"<uuid>","ok":true,"result":{…}}
{"type":"response","requestId":"<uuid>","ok":false,"error":{"code":"<ENUM>","message":"<str>","details":{…}?}}
{"type":"event","event":"<name>","payload":{…}}
```

Ошибка unknown-method: `UNSUPPORTED`. Error codes (общие): `INVALID_REQUEST`,
`UNSUPPORTED`, `NOT_ALLOWED`, `NOT_FOUND`, `OFFLINE`, `CONFLICT`, `LIMIT_EXCEEDED`,
`STALE_SOURCE`, `STALE_DEST`, `STALE_SCAN`, `IO`, `INTERNAL`.

### Handshake

`hello {shellProtocol:1, identitySeedHex(64), deviceName, deviceType, dataRoot, relayConfPubkey?, forceRelay?, customRelay?:{keyHex,host}, dhtBootstrap?:string[], updateSource?:{available,path,platform,size,sha256,signature}, updateTrust?:{publicKeyHex,allowUnsignedDevelopment?:bool}}`
→ `{coreProtocol:1, coreVersion, buildLabel, capabilities:["fs.v1","chat.v1"], deviceId}`
`deviceId` = 64-hex device pubkey (ed25519) and is the **only device identity key** used for peer lookup, journals, transfer scheduling, recovery and ACL checks. `deviceName` / peer `name` are presentation-only labels and may collide or change without changing identity. Core до `hello` отвечает только `core.warning`-событиями.
`forceRelay` / `customRelay` / `dhtBootstrap` — тестовые рычаги E2E (forced relay GET). То же через argv `--force-relay`, `--relay-key=`, `--relay-host=`, `--dht-bootstrap=`.

### Shell methods

- `core.getStatus {}` → `{online, peers:[…summary], bootTimeMs, version, buildLabel, storageIncompleteBytes}`
- `peer.list {}` → `{peers:[{id,name,type,mine,online,connectionType:'direct'|'relay'|null,update?,pairedAt,lastSeen}]}`; `update` содержит `appVersion/buildLabel/platform/available/size/sha256/signature/signatureVerified/signatureRequired/trustedSource/usable`.
- `peer.forget {id}`
- `pairing.createCode {}` → `{code}` (новый одноразовый 64-hex topic на каждый вызов; предыдущий поиск отменяется)
- `pairing.joinCode {code}` → `{ok}` → событие `pairing.changed` (`searching`, затем `request` на стороне host)
- `pairing.accept {pendingId, mine:bool}` / `pairing.decline {pendingId}`
  (`pendingId` = remote device pubkey hex)
- `roots.addLocal {path, name?, perms:{read,write}}` → `{root}`;
  `roots.removeLocal {rootId}`; `roots.listLocal {}` → `{roots:[RootInfo]}`
  `RootInfo = {rootId(uuid36), name, path, readOnlyRoot?}`
- `roots.browse {}` (в wire: `roots`) — список доступных пиру (logical name+rootId+perms)
- `fs.list {target:{peerId?|null, rootId, relativePath}, cursor?}` → `{scanId?, entries, nextCursor, previousCursor?}`
  `entry = {relativePath, name, type:'file'|'dir', size, mtimeMs}` (page 128; dir-first, name asc;
  local/remote один контракт; первая страница фиксирует bounded directory snapshot (≤50000 entries, ≤8 live snapshots), последующие страницы используют opaque snapshot-cursor; expired/foreign cursor → `STALE_SCAN`/`INVALID_REQUEST`; remote — wire `LIST` page-stream)
- wire `fs.hash {rootId, relativePath}` → `{size, mtimeMs, contentHash}` (GET одного файла; MANIFEST только для каталогов)
- `fs.stat {target}` → `{entry}`
- `fs.manifest {source:{peerId?|null,rootId,relativePath}, filter?:{include:[],exclude:[]}}` →
  `{scanId, fileCount, totalBytes, entriesDigest, expiresAtMs}`. Shell заранее резервирует `scanId` и публикует `fs.manifestStarted`, поэтому `fs.manifestCancel` может остановить ещё выполняющийся traversal/hash; hash выполняется bounded-пулом, snapshot ≤100000 entries.
- `fs.manifestPage {scanId, cursor}` → `{entries(≤128): {relativePath,type,size,mtimeMs,contentHash?}, nextCursor}`
- `fs.copy {items:[{source, destinationRelativePath?, collision?}], destination, collision?, preFlashed?}` →
  `{batchId, acceptedCount, operationIds}`. Batch durable-журналируется полностью **до** запуска первой transfer-chain. Для небольших batch `operationIds` возвращаются inline (≤256); для больших массив пустой и shell отслеживает job по `batchId`, чтобы RPC-ответ никогда не зависел от числа файлов. Живые transfer-chain запускаются bounded-dispatcher'ом, остальные строки остаются только в journal.
- `fs.syncPreview {source, destination, filter?}` → `{previewId, expiresAtMs, totals, sourceScanId}`. Полный actionable diff остаётся в Core, чтобы preview на тысячах файлов не превышал IPC frame.
- `fs.syncCancel {previewId}` → `{ok:true}` — немедленно освобождает preview/pinned source snapshot.
- `fs.syncStart {previewId, itemPaths?}` → тот же compact `CopyResult`; selected new+changed принимаются одним durable batch, без частично запущенного multi-copy.
- `operation.list {cursor?, limit?, peerId?}` → `{operations, nextCursor}`; page ≤128, default 128. Ответ содержит компактные поля для resume-панели, включая `batchId`, `waitingAgeMs`, `recoveryBlocked`, `longTermWaiting`, и не возвращает source/destination/partPath.
- `operation.batchStatus {batchId}` → `{batchId,total,completed,remaining,done}` для восстановления batch-прогресса после compact `fs.copy`/overflow UI events.
- `operation.cancel {operationId, scope?:'file', relativePath?}` — user cancel (journal discard
   правила отмены; при offline — `cancel-pending`)
- `operation.cancelBatch {batchId, relativePath?}` — остановка ещё не завершённых операций UI-батча;
   `relativePath` ограничивает отмену выбранной строкой/веткой; результат `{ok, cancelled, pending, skipped}`.
- `operation.cleanup {operationId}` — явная очистка только `stale` или `recovery-blocked` operation;
   удаляет её `.part` и journal, не трогая finalize backup при конфликте.

- `operation.resume {operationId?|null}` → явное "Возобновить"; без id — resume all. Ядро
  при reconnect автоматически инициирует RESUME только для роли receiver-bytes,
  queued-журналы другой стороны поднимаются автоматически по descriptorHash.
- `chat.send {peerId, text}` → `{messageId(uuid), state:'sent'|'queued-offline'}`
- `chat.history {peerId, limit?}` → `{messages:[{messageId, direction:'out'|'in', text, tsMs, state}]}`
- `update.request {peerId}` → staged update metadata `{path,version,buildLabel,platform,size,sha256,signature?,signatureVerified,signatureRequired,trustedSource:true}`. Core принимает executable update только от remembered peer, локально отмеченного как `mine`. Для текущей portable-сборки pinned update key отсутствует, поэтому `signatureRequired=false`; обязательная проверка целостности — exact size + SHA-256 после скачивания и повторно в Python updater перед заменой `PSN.exe`. Если в другой конфигурации pinned public key задан и unsigned mode выключен, Core дополнительно требует валидную Ed25519-подпись.
- `app.shutdown {}`

### Events

- `core.ready {}`; `core.warning {code,message}`; `core.fatal {code,message}`
- `peer.presence {id, online:bool, connectionType?}`
- `pairing.changed {event:'searching'|'connected'|'waiting-confirmation'|'request'|'confirmed'|'declined'|'expired', role?, pendingId?, name?, deviceType?, fingerprint?, reason?}`; для `request` на host `pendingId` = authenticated remote device pubkey, а `fingerprint` строится из него.
  (`expired` + `reason:'search-timeout'` — поиск остановлен, UI сбрасывает статус)
- `fs.listPage {reqId, target, entries, nextCursor, done}` (для remote-list, если shell хочет стриминг)
- `operation.progress {operationId, relativePath, role, bytesDone, bytesTotal, chunkDone, chunkTotal, state}`
- `operation.state {operationId, state, error?, filesDone, filesTotal}`
- `sync.progress {previewId|operationIds, done, total}`
- `chat.message {peerId, messageId, text, tsMs, direction:'in'}`
- `update.progress {peerId, receivedBytes, totalBytes}`
- `peer.updateInfo {peerId, update}` — metadata релиза; `signatureVerified` вычисляется локальным Core по pinned key и не доверяется значению от peer. `signatureRequired` отражает локальную policy receiving Core, а не заявление удалённого устройства.
- `fs.rootsChanged {roots}` — после roots.*Local (для refresh).

## 3. States (journal/operation)

```
state: queued → active → (done | cancel-pending → gone | stale → gone)
                 ↘ waiting-peer (off/reconnect → active|RESUME)
recovery: attempts + nextAttemptAtMs; after the finite retry budget → recovery-blocked
```
`.part`+journal: preserve при socket lost/offline/restart; discard при cancelOperation
(после ack-правила), STALE_*, corrupt journal (safe discard/restart); cleanup при success.

### OperationDescriptor (wire + journal, канонизированный)

```
FsEndpoint = {deviceId, rootId, relativePath}
OperationDescriptor = {
  operationId (uuid),
  source: FsEndpoint,
  destination: FsEndpoint,
  sourceFingerprint: {size, blake2b256(32B hex64)}|null,      # файлов; dir=null
  destFingerprint: {size, blake2b256}|null,                    # overwrite-контроль
  size, chunkSize,                                             # для file operations
  collision: 'rename'|'overwrite',
  createdAtMs
}
descriptorHash = blake2b-256(canonicalEncoding(OperationDescriptor))
```

canonicalEncoding = фиксированный порядок ключей и типов, сериализация (не JS JSON.stringify
с неизвестным порядком): массив пар `[["collision","rename"],["createdAtMs",123],…]`,
числа — decimal-строки, вложенные объекты рекурсивно так же, digest вычисляется
по UTF-8 байтам этого канона. Реализация: portable/encoding.ts (unit-tested).

Journal-файлы (Core, `dataRoot/journals/`): `sender/<operationId>.json`,
`receiver/<operationId>.json` (роль = **по факту bytes-receiver**, не initiator):
```
{descriptor, descriptorHash, role, state, initiatedLocally, peerPrepared,
  files:[{relativePath, fileId, state, bitmapHex, partPath, savedTo,
  finalize?:{phase:'prepared'|'backup-created'|'target-replaced',targetPath,backupPath?}, ...descriptor-leaf}],
  recovery:{generation, leaseId, attempts, lastAttemptAtMs, nextAttemptAtMs,
    lastErrorCode, lastErrorScope, requiresUserAction, blocked},
  waitingSinceMs, createdAtMs, updatedAtMs}

```
`.part` уникален по `operationId`; одинаковый destination сериализуется destination-lock. Overwrite использует durable finalize-state machine: backup path фиксируется **до** destructive rename, backup удаляется только после подтверждённого `x-result`.
- atomic checkpoint: `.tmp` + rename; chunk помечается принятым ПОСЛЕ записи `.part`;
  fsync на checkpoint (`final` + периодический), не на каждый chunk.

## 4. fs.v1 wire (Core↔Core): protomux `FS_PROTOCOL` на authenticated Discovery-connection

Envelope: `{v:1, requestId(uuid), method, payload}` / `{v:1, requestId, ok, result}|{v:1, requestId, ok:false, error:CODE}`
или событие без requestId `{v:1, event, payload}`. Live drive-сессии — существующий
канал `DRIVE_PROTOCOL` (PeerDrive): start/need/complete/ack/cancel, chunk frames.
`transferId` = live-ключ drive сессии (новый на reconnect), `operationId` — persistent.

Команды (только paired+authenticated peer;Capabilities сверяются на `capabilities`):
- `capabilities {}` → `{fs:['v1'], chat:['v1'], limits:{pageSize:500, maxManifest:100000, concurrent:2}}`
- `roots {}` → `{roots:[{rootId, name, perms:{read,write}}]}` (для UI пира; absolute не передаётся)
- `LIST {rootId, relativePath, cursor?}` → `{entries(≤500), nextCursor, dirMtimeMs}`
- `STAT {rootId, relativePath}` → `{entry}`
- `MANIFEST start {scanId?, rootId, relativePath, filter?}` → `{scanId, fileCount, totalBytes, entriesDigest, expiresAtMs}`; переданный `scanId` позволяет параллельному `MANIFEST cancel` остановить scan до ответа start
- `MANIFEST page {scanId, cursor}` → `{entries(≤500 + contentHash для files), nextCursor}`
- `MANIFEST cancel {scanId}` → `{ok}`
- `MKDIR {rootId, relativePath, recursive:true}` → `{ok}` — только как часть PUT-назначения
- `PUT start {descriptor(без chunkState), operationId, descriptorHash}` → `{ok, receiverState:{receivedBytes}}`
  (валидирует destination endpoint = own deviceId+root perms write+containment;
  collision rename; `CONFLICT` — type mismatch)
- `PUT file {operationId, relativePath, transferId(drive key), size, contentHash}` → `{ok, resumeBitmap}` —
  сервер открывает receive (drive receiveFile) для нового live-сеанса; чанки по drive-каналу.
- `PUT end {operationId}` → `{ok}` (ожидаем финализацию)
- `GET prepare {operationId, descriptorHash, source:{rootId,relativePath}}` → `{ok, size, contentHash}`
  (GET = pull-зеркало PUT: тот же drive-транспорт, стороны меняются ролями sender/receiver)
- `GET file {operationId, relativePath, transferId, resume?{bitmap?}}` → сервер вызывает PeerDrive.serve
- `RESUME {operationId, descriptorHash, receiverBitmapSummary}` → `{ok|error, freshSource:true/false}`
  (инициирует bytes-receiver; sender: journal lookup + re-hash source + fingerprint compare)
- `x-resume.prepare {operationId, descriptorHash, recoveryGeneration}` → `{state:'VERIFYING'|'READY'}`;
  полный source hash выполняется отдельной job с heartbeat и не держит transport RPC.
- `x-resume.status {operationId, recoveryGeneration}` → `{state:'VERIFYING'|'READY'}`; ошибка job
  возвращается как operation error и не закрывает peer socket.
- `x-open` и `x-ready` принимают `recoveryGeneration`; `STALE_GENERATION` отклоняется без reset transport.
- `cancelRequest {transferId}` — снять live drive-сессию без user-cancel семантики
- `cancelOperation {operationId, descriptorHash}` → `{ok, ackRequired}`; ack-обмен
  `cancelOperation ack` — после ack обе стороны discard (offline: `cancel-pending` до ack)
- `fs.error {operationId?, requestId?, code, fatal?:bool}`

### chat.v1 (protomux `CHAT_PROTOCOL`)
`{v:1, t:'msg', messageId(uuid), text(≤8192B), tsMs}` / `{t:'ack', messageId}` /
`{t:'typing', on:bool}`. Хранение: Core `dataRoot/chat/<peerId>.events` — append-only protected-json event log (`message`/`state`) с периодической compaction до последних 5000 сообщений; legacy `<peerId>.json` мигрируется commit-then-delete. `peerId` — криптографический device id, не display name. duplicate messageId drop; queue offline в Core, auto-send на `peer.presence online`. chat только paired (wire игнорирует не-remembered).

## 5. Sandbox semantics

Единый `resolveAllowedPath(rootId, relativePath, operation{LIST|STAT|GET|MANIFEST|MKDIR|PUT})`:
- rootId из allowlist (иначе `NOT_ALLOWED`), perms по операции;
- relativePath canonical (внутренний формат `/`-separated) без `..`/`.`/absolute/drive/UNC/
  `\\?\`/ADS `name:stream`/trailing dot|space/reserved (CON,PRN,AUX,NUL,COM1-9,LPT1-9,
  и с расширениями)/≤4096 UTF-8 bytes;
- read: каждый существующий сегмент — lstat, symlink/junction/reparse → `NOT_ALLOWED`
  (внутри root skip с `skipped`-пометкой в entries, вне — отказ);
- write (PUT/MKDIR dest): canonicalize существующего parent, containment,
  сегменты-проверки, создать, проверить final path; существующий destination —
  так же; `.part`/temp — только в каталоге destination root;
- rename display name ≠ new rootId; physical path change ⇒ новый rootId; удаление
  root ⇒ инвалидация journals (state stale→cleanup).
Оба конца (LIST-сервер и PUT-получатель) вызывают свой локальный resolver; по wire
ходят только `{rootId, relativePath}`.

## 6. Лимиты (константы portable/limits.ts)

LIST page=500; LIST snapshot TTL=30 s; MANIFEST page=500; snapshot=100000 entries; scan TTL=10 min;
metadata concurrency=32; manifest hash concurrency=4; contentHash=blake2b-256 raw32; concurrent PUT+GET на пира=2; chat text=8192 B;
IPC/fs frame ≤1 MiB (fs-frame ≤900 KiB полезной JSON).

## 7. Concurrency/queue

Core: LIST первой страницы делает один bounded metadata scan и фиксирует snapshot; последующие pages его не пересканируют. MANIFEST hashes выполняются bounded-пулом на операцию, source/destination sync scans могут идти параллельно. PUT/GET на криптографический `peerId` — ≤2 concurrent; одинаковый destination path дополнительно сериализован; journal writes проходят через per-file queue.

## 8. Restart flow

1. Python читает DPAPI identity → `hello`.
2. Core поднимает Discovery-swarm (device keypair, firewall по remembered, relay config),
   загружает roots+journals+chat, шлёт `core.ready`.
3. Все `active` journal-entries → `waiting-peer`; при online пира receiver-bytes шлёт
   RESUME; shell UI-кнопки: Retry/Cancel (cancel=user-cancel, не disconnect).
```
