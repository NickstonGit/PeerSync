"""PeerSync portable — local E2E.

Два PSNCore.exe, pairing, GET ~2 GB, kill/resume, STALE_SOURCE,
chat offline queue, sync remote-only, optional forced relay.

    python scripts/e2e-two-cores.py [pathToCoreExe] [--relay]

Env:
  E2E_BIG_MB          size of big.bin (default 2048)
  E2E_RELAY          1 to also run forced-relay GET (default 1)
  E2E_RELAY_BIG_MB   relay GET size; default = E2E_BIG_MB; 0 skips 2 GB relay
  E2E_REQUIRE_CHECKPOINT  0 to allow killing before the first durable checkpoint
                            (default: 1 whenever the fixture is big enough)
"""

import json
import os
import glob
import queue
import shutil
import sys
import time
import hashlib
import random
import subprocess

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(APP, "apps", "portable-python"))

from ipc.core_client import CoreClient  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FLAGS = {a for a in sys.argv[1:] if a.startswith("--")}
CORE = ARGS[0] if ARGS else os.path.join(APP, "build", "core", "PSNCore.exe")
CORE = os.path.abspath(CORE)
BASE = os.path.join(APP, "build", "e2e")
A_DIR = os.path.join(BASE, "A")
B_DIR = os.path.join(BASE, "B")
C_DIR = os.path.join(BASE, "C")
D_DIR = os.path.join(BASE, "D")
A_ROOT = os.path.join(BASE, "aroot")
B_ROOT = os.path.join(BASE, "broot")
C_ROOT = os.path.join(BASE, "croot")
D_ROOT = os.path.join(BASE, "droot")

BIG_MB = int(os.environ.get("E2E_BIG_MB", "2048"))
WANT_RELAY = "--relay" in FLAGS or os.environ.get("E2E_RELAY", "1") not in ("0", "false", "no")
RELAY_BIG_MB = int(os.environ.get("E2E_RELAY_BIG_MB", str(BIG_MB)))
STALE_MB = 32
GET_PROGRESS_BYTES = min(20_000_000, max(1, (BIG_MB * (1 << 20)) // 8))
CANCEL_PROGRESS_BYTES = min(4_000_000, max(1, (BIG_MB * (1 << 20)) // 2))
CHECKPOINT_MIN_BYTES = 64 * (1 << 20)
# The core's first durable chunk checkpoint lands at 64 MiB. Killing before that
# point only proves the receiver restarts from scratch, which is not the property
# this run exists to check, so the kill is moved past the first checkpoint
# whenever the fixture is big enough to have one.
FIXTURE_BYTES = BIG_MB * (1 << 20)
CHECKPOINT_REACHABLE = FIXTURE_BYTES >= CHECKPOINT_MIN_BYTES * 2
if CHECKPOINT_REACHABLE:
    GET_PROGRESS_BYTES = max(GET_PROGRESS_BYTES, CHECKPOINT_MIN_BYTES + (1 << 20))
REQUIRE_CHECKPOINT = os.environ.get(
    "E2E_REQUIRE_CHECKPOINT",
    "1" if CHECKPOINT_REACHABLE else "0",
) in ("1", "true", "yes")
GET_TIMEOUT = max(900, BIG_MB * 8)
# A manifest hashes every file it walks, so scanning the tree that holds big.bin
# costs roughly what reading it costs. The default 60s request timeout is sized
# for small fixtures and cancels a 2 GB scan mid-hash, which is a harness limit,
# not a product failure.
SCAN_TIMEOUT = max(120, BIG_MB * 4)


def log(*a):
    line = " ".join(str(x) for x in a)
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        sys.stdout.buffer.write((line + "\n").encode(enc, "replace"))
        sys.stdout.flush()


def part_files(target):
    return glob.glob(target + ".peersync-part-*.part") + glob.glob(target + ".altersend-part-*.part")


_owned_nodes = []


class Node:
    def __init__(self, tag, data_root, seed_hex, name, extra_args=None, hello_extra=None):
        os.makedirs(data_root, exist_ok=True)
        for sub in ("peers", "topics", "journals", "chat", "logs"):
            os.makedirs(os.path.join(data_root, sub), exist_ok=True)
        extra = list(extra_args or [])
        if "--debug" not in extra:
            extra.append("--debug")
        self.client = CoreClient(
            CORE,
            data_root,
            os.path.join(data_root, "logs", "core.log"),
            "0.0.0",
            "e2e",
            extra_args=extra,
        )
        self.events = queue.Queue()
        self.tag = tag
        self.extra_args = extra
        self.hello_extra = dict(hello_extra or {})

        def on_event(frame):
            self.events.put(frame)

        _owned_nodes.append(self)
        self.client.start(on_event)
        payload = {
            "shellProtocol": 1,
            "identitySeedHex": seed_hex,
            "deviceName": name,
            "deviceType": "desktop",
            "dataRoot": data_root,
        }
        payload.update(self.hello_extra)
        ack = self.client.request("hello", payload, timeout=60)
        assert ack["ok"], ack
        self.device_id = ack["result"]["peerId"]
        self.data_root = data_root
        self.seed_hex = seed_hex
        self.name = name

    def req(self, method, payload=None, timeout=60):
        return self.client.request(method, payload or {}, timeout=timeout)

    def wait_event(self, pred, label, timeout=90):
        deadline = time.time() + timeout
        backlog = []
        while time.time() < deadline:
            try:
                ev = self.events.get(timeout=0.5)
            except queue.Empty:
                continue
            if pred(ev):
                for b in backlog:
                    self.events.put(b)
                return ev
            backlog.append(ev)
        raise AssertionError("timeout waiting for event: " + label)

    def stop(self, graceful=True):
        try:
            self.client.stop(graceful=graceful, timeout=8)
        except Exception:
            pass

    def kill_hard(self):
        try:
            if self.client.proc is not None and self.client.proc.poll() is None:
                self.client.proc.kill()
                self.client.proc.wait(10)
        except Exception:
            pass
        try:
            self.client.stop(graceful=False, timeout=0.4)
        except Exception:
            pass


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def blake256(path):
    h = hashlib.blake2b(digest_size=32)
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_pattern_file(path, megabytes, seed):
    rnd = random.Random(seed)
    chunk = bytes(rnd.getrandbits(8) for _ in range(1 << 20))
    h = hashlib.sha256()
    b = hashlib.blake2b(digest_size=32)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        for _ in range(megabytes):
            fh.write(chunk)
            h.update(chunk)
            b.update(chunk)
    return h.hexdigest(), b.hexdigest()


def overwrite_same_size(path):
    size = os.path.getsize(path)
    with open(path, "r+b") as fh:
        n = min(size, 1 << 20)
        fh.write(b"Y" * n)
        if size > 1:
            fh.seek(size - 1)
            fh.write(b"Z")


def start_local_relay():
    script = os.path.join(APP, "scripts", "e2e-dht-relay.mjs")
    proc = subprocess.Popen(
        ["node", script, os.path.join(BASE, "relay-stats.json")],
        cwd=APP,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline()
    if not line:
        err = proc.stderr.read() if proc.stderr else ""
        raise RuntimeError("e2e-dht-relay produced no stdout: " + err)
    info = json.loads(line)
    assert info.get("ok") and info.get("key") and info.get("host"), info
    log("local relay", info["key"][:12], info["host"], info.get("port"))
    return proc, info



def set_peer_write(owner, root, peer_id, allowed):
    reply = owner.req(
        "roots.setPeerPerms",
        {
            "rootId": root["rootId"],
            "peerId": peer_id,
            "perms": {"write": bool(allowed)},
        },
    )
    assert reply.get("ok"), reply


def pair_and_roots(a, b, a_root, b_root, aname, bname):
    code = a.req("pairing.createCode")["result"]["code"]
    assert len(code) == 64, code
    time.sleep(2)
    b.req("pairing.joinCode", {"code": code})
    request = a.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e["payload"].get("event") == "request",
        "A host confirmation request",
        120,
    )
    pending_id = request["payload"].get("pendingId")
    assert pending_id and len(pending_id) == 64, request
    # Entering the code is only the joiner's request.  The code creator must
    # explicitly accept the authenticated device before either side confirms.
    a.req("pairing.accept", {"pendingId": pending_id, "mine": False})
    a.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e["payload"].get("event") == "confirmed",
        "A confirmed",
        120,
    )
    b.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e["payload"].get("event") == "confirmed",
        "B confirmed",
        120,
    )
    a.req("peer.poke", {"id": b.device_id})
    b.req("peer.poke", {"id": a.device_id})
    ra = a.req("roots.addLocal", {"path": a_root, "name": aname, "perms": {"read": True, "write": False}})["result"]["root"]
    rb = b.req("roots.addLocal", {"path": b_root, "name": bname, "perms": {"read": True, "write": False}})["result"]["root"]
    a.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "A sees B online", 120)
    b.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "B sees A online", 60)
    set_peer_write(a, ra, b.device_id, True)
    set_peer_write(b, rb, a.device_id, True)
    return ra, rb


def connection_type(node, peer_id):
    peers = node.req("peer.list")["result"]["peers"]
    row = next((p for p in peers if p["id"] == peer_id), None)
    return None if row is None else row.get("connectionType")


def make_fixtures():
    shutil.rmtree(BASE, ignore_errors=True)
    os.makedirs(A_ROOT, exist_ok=True)
    os.makedirs(B_ROOT, exist_ok=True)
    with open(os.path.join(A_ROOT, "f1.txt"), "wb") as fh:
        fh.write(b"peersync e2e small file\n" * 3)
    os.makedirs(os.path.join(A_ROOT, "nested", "deep"), exist_ok=True)
    rnd = random.Random(11)
    blob1 = bytes(rnd.getrandbits(8) for _ in range(400_000))
    with open(os.path.join(A_ROOT, "nested", "blob1.bin"), "wb") as fh:
        fh.write(blob1)
    with open(os.path.join(A_ROOT, "nested", "deep", "conf.txt"), "wb") as fh:
        fh.write(b"host=deep\n")
    log("writing big.bin %d MB..." % BIG_MB)
    big_sha, big_blake = write_pattern_file(os.path.join(A_ROOT, "big.bin"), BIG_MB, 11)
    stale_sha, stale_blake = write_pattern_file(os.path.join(A_ROOT, "stale.bin"), STALE_MB, 22)
    return {
        "f1": sha(os.path.join(A_ROOT, "f1.txt")),
        "blob1": sha(os.path.join(A_ROOT, "nested", "blob1.bin")),
        "conf": sha(os.path.join(A_ROOT, "nested", "deep", "conf.txt")),
        "big": big_sha,
        "big_blake": big_blake,
        "f1_blake": blake256(os.path.join(A_ROOT, "f1.txt")),
        "stale": stale_sha,
        "stale_blake": stale_blake,
    }


def restart_pair(prev_a, prev_b, a_dir, b_dir, seed_a, seed_b, extra_args=None, hello_extra=None):
    extra = extra_args if extra_args is not None else prev_a.extra_args
    hello = hello_extra if hello_extra is not None else prev_a.hello_extra
    a2 = Node(prev_a.tag + "2", a_dir, seed_a, prev_a.name, extra_args=extra, hello_extra=hello)
    b2 = Node(prev_b.tag + "2", b_dir, seed_b, prev_b.name, extra_args=extra, hello_extra=hello)
    return a2, b2


def run_direct(fx):
    seed_a = "11" * 32
    seed_b = "22" * 32
    a = Node("A", A_DIR, seed_a, "A-box")
    b = Node("B", B_DIR, seed_b, "B-box")
    log("hello A device", a.device_id[:12], "B device", b.device_id[:12])
    ra_root, rb_root = pair_and_roots(a, b, A_ROOT, B_ROOT, "Aroot", "Broot")
    log("pairing OK; connectionType A->B", connection_type(a, b.device_id))

    remote_entries = a.req("fs.list", {"target": {"peerId": b.device_id, "rootId": rb_root["rootId"], "relativePath": ""}})
    assert remote_entries["ok"], remote_entries
    roots_b = a.req("fs.list", {"target": {"peerId": b.device_id, "rootId": "dbb21e72-dead-4e2b-a818-22dc04af9bad", "relativePath": ""}})
    assert not roots_b["ok"] and roots_b["error"]["code"] in ("NOT_ALLOWED", "NOT_FOUND"), roots_b

    man = a.req("fs.manifest", {"action": "start", "target": {"rootId": ra_root["rootId"], "relativePath": ""}}, timeout=SCAN_TIMEOUT)
    assert man["ok"], man
    entries = a.req("fs.manifest", {"action": "page", "scanId": man["result"]["scanId"]}, timeout=SCAN_TIMEOUT)["result"]["items"]
    names = {e["relativePath"] for e in entries}
    assert "f1.txt" in names and "big.bin" in names and "stale.bin" in names, names
    f1_entry = next(e for e in entries if e["relativePath"] == "f1.txt")
    assert f1_entry["contentHash"] == fx["f1_blake"], (f1_entry["contentHash"], fx["f1_blake"])
    log("blake2b-256 matches python reference [ok]")

    rl = b.req("fs.list", {"target": {"peerId": a.device_id, "rootId": ra_root["rootId"], "relativePath": ""}})
    assert rl["ok"] and {"f1.txt", "nested", "big.bin", "stale.bin"} <= {e["name"] for e in rl["result"]["entries"]}, rl
    rman = b.req("fs.manifest", {"action": "start", "target": {"peerId": a.device_id, "rootId": ra_root["rootId"], "relativePath": "nested"}}, timeout=120)
    assert rman["ok"], rman
    ritems = b.req("fs.manifest", {"action": "page", "scanId": rman["result"]["scanId"]})["result"]["items"]
    assert {it["relativePath"] for it in ritems} == {"blob1.bin", "deep/conf.txt"}, ritems
    log("remote LIST + MANIFEST paged OK")

    evil = a.req("fs.list", {"target": {"peerId": b.device_id, "rootId": rb_root["rootId"], "relativePath": "../.."}}, timeout=20)
    assert not evil["ok"] and evil["error"]["code"] in ("INVALID_REQUEST", "NOT_ALLOWED"), evil
    log("wire traversal rejected:", evil["error"]["code"])

    op = a.req("fs.copy", {
        "destination": {"peerId": b.device_id, "rootId": rb_root["rootId"], "relativePath": "incoming"},
        "items": [{"source": {"rootId": ra_root["rootId"], "relativePath": "f1.txt"}}],
        "collision": "rename",
    })["result"]["operationIds"]
    assert len(op) == 1, op
    a.wait_event(lambda e: e.get("event") == "operation.state" and e["payload"].get("state") == "done" and e["payload"].get("operationId") == op[0], "PUT f1 done A", 180)
    b.wait_event(lambda e: e.get("event") == "operation.state" and e["payload"].get("state") == "done" and e["payload"].get("operationId") == op[0], "PUT f1 done B", 180)
    assert sha(os.path.join(B_ROOT, "incoming", "f1.txt")) == fx["f1"], "PUT content mismatch"
    log("PUT f1.txt verified on destination [ok]")

    ops = a.req("fs.copy", {
        "destination": {"peerId": b.device_id, "rootId": rb_root["rootId"], "relativePath": ""},
        "items": [{"source": {"rootId": ra_root["rootId"], "relativePath": "nested"}}],
        "collision": "rename",
    })["result"]["operationIds"]
    assert len(ops) == 2, ops
    for oid in ops:
        a.wait_event(lambda e, oi=oid: e.get("event") == "operation.state" and e["payload"].get("state") == "done" and e["payload"].get("operationId") == oi, "PUT dir %s" % oid, 240)
    assert sha(os.path.join(B_ROOT, "nested", "blob1.bin")) == fx["blob1"]
    assert sha(os.path.join(B_ROOT, "nested", "deep", "conf.txt")) == fx["conf"]
    log("PUT directory fan-out + structure preserved [ok]")

    msg = a.req("chat.send", {"peerId": b.device_id, "text": "привет B"})
    assert msg["ok"] and msg["result"]["state"] == "delivered", msg
    b.wait_event(lambda e: e.get("event") == "chat.message" and e["payload"]["text"] == "привет B", "chat rx", 30)
    hist = b.req("chat.history", {"peerId": a.device_id})["result"]["messages"]
    assert hist and hist[-1]["text"] == "привет B", hist
    log("chat online delivery + history [ok]")

    log("GET %d MB starting (B pull)..." % BIG_MB)
    big_res = b.req("fs.copy", {
        "destination": {"rootId": rb_root["rootId"], "relativePath": "got"},
        "items": [{"source": {"peerId": a.device_id, "rootId": ra_root["rootId"], "relativePath": "big.bin"}}],
        "collision": "rename",
    }, timeout=300)
    assert big_res.get("ok"), big_res
    big_op = big_res["result"]["operationIds"][0]
    got = b.wait_event(
        lambda e: e.get("event") == "operation.progress" and e["payload"].get("operationId") == big_op and e["payload"].get("bytesDone", 0) > GET_PROGRESS_BYTES,
        "big receiver progress mid",
        GET_TIMEOUT,
    )
    done_mid = got["payload"]["bytesDone"]
    log("mid-GET at", done_mid, "bytes - killing BOTH cores")
    a.kill_hard()
    b.kill_hard()

    a2, b2 = restart_pair(a, b, A_DIR, B_DIR, seed_a, seed_b)
    ra2 = a2.req("roots.addLocal", {"path": A_ROOT, "name": "Aroot", "perms": {"read": True, "write": True}})["result"]["root"]
    rb2 = b2.req("roots.addLocal", {"path": B_ROOT, "name": "Broot", "perms": {"read": True, "write": True}})["result"]["root"]
    b2.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "B2 presence", 180)
    a2.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "A2 presence", 60)
    ops_list = b2.req("operation.list")["result"]["operations"]
    row = next((o for o in ops_list if o["operationId"] == big_op), None)
    assert row is not None and row["state"] in ("waiting-peer", "queued", "active"), ops_list
    log("journal survived kill: state", row["state"], "bytesDone", row["bytesDone"])
    if REQUIRE_CHECKPOINT:
        assert row["bytesDone"] > 0, "receiver journal must persist chunk checkpoints"
    else:
        log("checkpoint assertion skipped for this fixture size")
    rb2_ = None
    for _try in range(8):
        rb2_ = b2.req("operation.resume", {"operationId": big_op}, timeout=120)
        if rb2_["ok"] and rb2_["result"].get("ok"):
            break
        time.sleep(5)
    assert rb2_["ok"] and rb2_["result"].get("ok"), rb2_
    b2.wait_event(lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == big_op and e["payload"].get("state") == "done", "resume done", GET_TIMEOUT)
    dst = os.path.join(B_ROOT, "got", "big.bin")
    assert sha(dst) == fx["big"], "RESUMED GET file corrupted"
    assert blake256(dst) == fx["big_blake"]
    ops_after = b2.req("operation.list")["result"]["operations"]
    assert all(o["operationId"] != big_op for o in ops_after), "journal should be removed after done"
    log("KILL-RESUME GET %d MB SHA + blake2b verified, journal cleaned [ok]" % BIG_MB)

    stale_op = b2.req("fs.copy", {
        "destination": {"rootId": rb2["rootId"], "relativePath": "stale-got"},
        "items": [{"source": {"peerId": a2.device_id, "rootId": ra2["rootId"], "relativePath": "stale.bin"}}],
        "collision": "rename",
    }, timeout=60)["result"]["operationIds"][0]
    b2.wait_event(
        lambda e: e.get("event") == "operation.progress" and e["payload"].get("operationId") == stale_op and e["payload"].get("bytesDone", 0) > 4_000_000,
        "stale mid progress",
        180,
    )
    log("stale.bin mid-transfer - killing BOTH, mutating source same size")
    a2.kill_hard()
    b2.kill_hard()
    overwrite_same_size(os.path.join(A_ROOT, "stale.bin"))
    a3, b3 = restart_pair(a2, b2, A_DIR, B_DIR, seed_a, seed_b)
    a3.req("roots.addLocal", {"path": A_ROOT, "name": "Aroot", "perms": {"read": True, "write": True}})
    rb3 = b3.req("roots.addLocal", {"path": B_ROOT, "name": "Broot", "perms": {"read": True, "write": True}})["result"]["root"]
    b3.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "B3 presence", 180)
    a3.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "A3 presence", 60)
    ops_stale0 = b3.req("operation.list")["result"]["operations"]
    stale_row0 = next((o for o in ops_stale0 if o["operationId"] == stale_op), None)
    resumed = {"ok": False}
    stale_ev = None
    if stale_row0 and stale_row0.get("state") == "stale":
        log("STALE_SOURCE already parked on reconnect")
    else:
        for _try in range(8):
            resumed = b3.req("operation.resume", {"operationId": stale_op}, timeout=180)
            err_code = (resumed.get("error") or {}).get("code")
            if err_code == "STALE_SOURCE":
                break
            if resumed.get("ok") and resumed.get("result", {}).get("ok"):
                break
            time.sleep(5)
        if resumed.get("ok") and resumed.get("result", {}).get("ok"):
            stale_ev = b3.wait_event(
                lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == stale_op and e["payload"].get("state") in ("stale", "STALE_SOURCE"),
                "stale after resume",
                180,
            )
        else:
            code = (resumed.get("error") or {}).get("code")
            assert code == "STALE_SOURCE", resumed
    ops_stale = b3.req("operation.list")["result"]["operations"]
    stale_row = next((o for o in ops_stale if o["operationId"] == stale_op), None)
    assert stale_row is None or stale_row.get("state") == "stale" or (stale_ev and stale_ev["payload"].get("state") in ("stale", "STALE_SOURCE")), (stale_row, resumed, stale_ev)
    dst_stale = os.path.join(B_ROOT, "stale-got", "stale.bin")
    new_src = sha(os.path.join(A_ROOT, "stale.bin"))
    if os.path.isfile(dst_stale):
        assert sha(dst_stale) != new_src, "STALE_SOURCE reused bitmap and completed with new bytes"
    log("STALE_SOURCE on same-size mutate; bitmap not reused [ok]")

    # Explicit online cancel must stop the data plane before control-plane
    # cleanup. In particular a cancelled receiver must never finalize the file.
    cancel_online_target = os.path.join(B_ROOT, "cancel-online", "big.bin")
    cancel_online_op = b3.req("fs.copy", {
        "destination": {"rootId": rb3["rootId"], "relativePath": "cancel-online"},
        "items": [{"source": {"peerId": a3.device_id, "rootId": a3.req("roots.listLocal")["result"]["roots"][0]["rootId"], "relativePath": "big.bin"}}],
        "collision": "rename",
    }, timeout=120)["result"]["operationIds"][0]
    b3.wait_event(
        lambda e: e.get("event") == "operation.progress" and e["payload"].get("operationId") == cancel_online_op and e["payload"].get("bytesDone", 0) > CANCEL_PROGRESS_BYTES,
        "online cancel progress",
        180,
    )
    cancelled = b3.req("operation.cancel", {"operationId": cancel_online_op}, timeout=120)
    assert cancelled["ok"] and cancelled["result"].get("ok") and not cancelled["result"].get("pending"), cancelled
    b3.wait_event(
        lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == cancel_online_op and e["payload"].get("state") == "cancelled",
        "online cancel ack",
        60,
    )
    assert not os.path.exists(cancel_online_target), "online cancel finalized destination file"
    assert not part_files(cancel_online_target), "online cancel ACK left .part"
    assert all(o["operationId"] != cancel_online_op for o in b3.req("operation.list")["result"]["operations"])
    log("online user cancel stops transfer; no final/.part after ACK [ok]")

    # Offline cancel is deliberately different from disconnect/crash: keep the
    # intent as cancel-pending, then deliver x-cancel and cleanup on reconnect.
    a3_root_id = a3.req("roots.listLocal")["result"]["roots"][0]["rootId"]
    cancel_offline_target = os.path.join(B_ROOT, "cancel-offline", "big.bin")
    cancel_offline_op = b3.req("fs.copy", {
        "destination": {"rootId": rb3["rootId"], "relativePath": "cancel-offline"},
        "items": [{"source": {"peerId": a3.device_id, "rootId": a3_root_id, "relativePath": "big.bin"}}],
        "collision": "rename",
    }, timeout=120)["result"]["operationIds"][0]
    b3.wait_event(
        lambda e: e.get("event") == "operation.progress" and e["payload"].get("operationId") == cancel_offline_op and e["payload"].get("bytesDone", 0) > CANCEL_PROGRESS_BYTES,
        "offline cancel progress",
        180,
    )
    a3.kill_hard()
    time.sleep(2)
    pending_cancel = b3.req("operation.cancel", {"operationId": cancel_offline_op}, timeout=60)
    assert pending_cancel["ok"] and pending_cancel["result"].get("ok") and pending_cancel["result"].get("pending"), pending_cancel
    pending_rows = b3.req("operation.list")["result"]["operations"]
    pending_row = next((o for o in pending_rows if o["operationId"] == cancel_offline_op), None)
    assert pending_row is not None and pending_row.get("state") == "cancel-pending", pending_rows
    assert not os.path.exists(cancel_offline_target), "offline cancel finalized destination file"
    assert part_files(cancel_offline_target), "cancel-pending must preserve .part until peer ACK"

    a4 = Node("A4", A_DIR, seed_a, "A-box", extra_args=a3.extra_args, hello_extra=a3.hello_extra)
    a4.req("roots.addLocal", {"path": A_ROOT, "name": "Aroot", "perms": {"read": True, "write": True}})
    a4.req("peer.poke", {"id": b3.device_id})
    b3.req("peer.poke", {"id": a4.device_id})
    b3.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "B3 sees A4", 180)
    a4.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "A4 sees B3", 60)
    b3.wait_event(
        lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == cancel_offline_op and e["payload"].get("state") == "cancelled",
        "offline cancel delivered after reconnect",
        120,
    )
    assert not os.path.exists(cancel_offline_target), "offline cancel reconnect finalized destination file"
    assert not part_files(cancel_offline_target), "offline cancel ACK did not remove .part"
    assert all(o["operationId"] != cancel_offline_op for o in b3.req("operation.list")["result"]["operations"])
    log("offline cancel -> cancel-pending -> reconnect ACK cleanup [ok]")
    a3 = a4

    os.makedirs(os.path.join(A_ROOT, "sd"), exist_ok=True)
    os.makedirs(os.path.join(B_ROOT, "sd"), exist_ok=True)
    with open(os.path.join(A_ROOT, "sd", "x.txt"), "wb") as fh:
        fh.write(b"NEW\n")
    with open(os.path.join(B_ROOT, "sd", "x.txt"), "wb") as fh:
        fh.write(b"OLD\n")
    ra_now = a3.req("roots.listLocal")["result"]["roots"][0]["rootId"]
    prev_sd = a3.req("fs.syncPreview", {
        "source": {"rootId": ra_now, "relativePath": "sd"},
        "destination": {"peerId": b3.device_id, "rootId": rb3["rootId"], "relativePath": "sd"},
    }, timeout=180)
    assert prev_sd["ok"], prev_sd
    with open(os.path.join(B_ROOT, "sd", "x.txt"), "wb") as fh:
        fh.write(b"MUTATED AFTER PREVIEW\n")
    started_sd = a3.req("fs.syncStart", {"previewId": prev_sd["result"]["previewId"]})
    assert started_sd["ok"], started_sd
    oid_sd = started_sd["result"]["operationIds"][0]
    ev_sd = a3.wait_event(
        lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == oid_sd and e["payload"].get("state") not in ("active", "queued"),
        "stale-dest state",
        180,
    )
    assert ev_sd["payload"]["state"] in ("stale", "STALE_DEST") or "STALE_DEST" in str(ev_sd["payload"].get("error") or ""), ev_sd
    assert open(os.path.join(B_ROOT, "sd", "x.txt"), "rb").read() == b"MUTATED AFTER PREVIEW\n"
    log("STALE_DEST after dest mutated between preview and start [ok]")

    b3.kill_hard()
    time.sleep(1)
    msgq = a3.req("chat.send", {"peerId": b3.device_id, "text": "queue-me-offline"})
    assert msgq["ok"] and msgq["result"]["state"] == "queued-offline", msgq
    hist_q = a3.req("chat.history", {"peerId": b3.device_id})["result"]["messages"]
    assert any(m.get("text") == "queue-me-offline" and m.get("state") == "queued-offline" for m in hist_q), hist_q
    b4 = Node("B4", B_DIR, seed_b, "B-box", extra_args=a3.extra_args, hello_extra=a3.hello_extra)
    b4.req("roots.addLocal", {"path": B_ROOT, "name": "Broot", "perms": {"read": True, "write": True}})
    b4.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "B4 presence", 180)
    a3.wait_event(lambda e: e.get("event") == "peer.presence" and e["payload"].get("online"), "A3 sees B4", 60)
    b4.wait_event(lambda e: e.get("event") == "chat.message" and e["payload"]["text"] == "queue-me-offline", "offline chat flushed", 60)
    log("chat queued-offline -> delivered after reconnect [ok]")

    set_peer_write(b4, rb3, a3.device_id, False)
    denied = a3.req("fs.copy", {
        "destination": {"peerId": b4.device_id, "rootId": rb3["rootId"], "relativePath": "nope"},
        "items": [{"source": {"rootId": ra_now, "relativePath": "f1.txt"}}],
    })
    oid = denied["result"]["operationIds"][0]
    fail_ev = a3.wait_event(lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == oid and e["payload"].get("state") not in ("active", "queued", "progress"), "write-denied state", 60)
    assert fail_ev["payload"]["state"] in ("stale", "waiting-peer"), fail_ev
    assert not os.path.exists(os.path.join(B_ROOT, "nope")), "denied PUT created files"
    log("write-permission revoked => PUT denied, no files created [ok]")

    set_peer_write(b4, rb3, a3.device_id, True)
    shutil.rmtree(os.path.join(B_ROOT, "sync"), ignore_errors=True)
    os.makedirs(os.path.join(B_ROOT, "sync"), exist_ok=True)
    with open(os.path.join(B_ROOT, "sync", "only-remote.txt"), "wb") as fh:
        fh.write(b"remote only\n")
    shutil.rmtree(os.path.join(A_ROOT, "sync"), ignore_errors=True)
    os.makedirs(os.path.join(A_ROOT, "sync"))
    with open(os.path.join(A_ROOT, "sync", "f1.txt"), "wb") as fh:
        fh.write(b"NEWER LOCAL\n")
    with open(os.path.join(A_ROOT, "sync", "fresh.txt"), "wb") as fh:
        fh.write(b"brand new file\n")
    with open(os.path.join(A_ROOT, "sync", "skip-me.zip"), "wb") as fh:
        fh.write(b"PK\x03\x04zip")
    prev = a3.req("fs.syncPreview", {
        "source": {"rootId": ra_now, "relativePath": "sync"},
        "destination": {"peerId": b4.device_id, "rootId": rb3["rootId"], "relativePath": "sync"},
        "filter": {"exclude": ["*.zip"]},
    }, timeout=180)
    assert prev["ok"], prev
    totals = prev["result"]["totals"]
    assert totals["new"] == 2 and totals["changed"] == 0 and totals["remote-only"] == 1, totals
    started = a3.req("fs.syncStart", {"previewId": prev["result"]["previewId"]})
    assert started["ok"], started
    opids = started["result"]["operationIds"]
    assert len(opids) == 2, opids
    for oid in opids:
        a3.wait_event(lambda e, oi=oid: e.get("event") == "operation.state" and e["payload"].get("operationId") == oi and e["payload"].get("state") == "done", "sync %s done" % oid, 300)
    assert open(os.path.join(B_ROOT, "sync", "f1.txt"), "rb").read() == b"NEWER LOCAL\n"
    with open(os.path.join(B_ROOT, "sync", "fresh.txt"), "rb") as fh:
        assert fh.read() == b"brand new file\n"
    assert os.path.exists(os.path.join(B_ROOT, "sync", "only-remote.txt"))
    log("sync preview(new+changed+remote-only)+filter zip; remote-only untouched [ok]")

    prev_rtl = a3.req("fs.syncPreview", {
        "source": {"peerId": b4.device_id, "rootId": rb3["rootId"], "relativePath": "sync"},
        "destination": {"rootId": ra_now, "relativePath": "sync"},
    }, timeout=180)
    assert prev_rtl["ok"], prev_rtl
    totals_rtl = prev_rtl["result"]["totals"]
    assert totals_rtl["new"] == 1 and totals_rtl["skipped"] == 2 and totals_rtl["remote-only"] == 1, totals_rtl
    started_rtl = a3.req("fs.syncStart", {"previewId": prev_rtl["result"]["previewId"]})
    assert started_rtl["ok"], started_rtl
    opids_rtl = started_rtl["result"]["operationIds"]
    assert len(opids_rtl) == 1, opids_rtl
    for oid in opids_rtl:
        a3.wait_event(lambda e, oi=oid: e.get("event") == "operation.state" and e["payload"].get("operationId") == oi and e["payload"].get("state") == "done", "sync rtl %s done" % oid, 300)
    assert open(os.path.join(A_ROOT, "sync", "only-remote.txt"), "rb").read() == b"remote only\n"
    assert os.path.exists(os.path.join(A_ROOT, "sync", "skip-me.zip"))
    assert not os.path.exists(os.path.join(B_ROOT, "sync", "skip-me.zip"))
    log("sync reverse remote->local copies only-remote; dest-only zip stays [ok]")

    a3.req("peer.forget", {"id": b4.device_id})
    peers_after = a3.req("peer.list")["result"]["peers"]
    assert not any(x["id"] == b4.device_id for x in peers_after), peers_after
    log("peer.forget cleaned lists")

    a3.stop()
    b4.stop()
    log("direct phase PASS")


def run_relay(fx, relay_info):
    if RELAY_BIG_MB <= 0:
        log("skip 2 GB relay (E2E_RELAY_BIG_MB=0); proving relay with stale.bin GET")
        size_name = "stale.bin"
        expect_sha = sha(os.path.join(A_ROOT, "stale.bin"))
        expect_blake = blake256(os.path.join(A_ROOT, "stale.bin"))
        timeout = 300
        progress_need = 1_000_000
    else:
        size_name = "big.bin"
        expect_sha = fx["big"]
        expect_blake = fx["big_blake"]
        timeout = GET_TIMEOUT
        progress_need = GET_PROGRESS_BYTES
        log("GET %d MB via forced relay..." % RELAY_BIG_MB)

    shutil.rmtree(C_DIR, ignore_errors=True)
    shutil.rmtree(D_DIR, ignore_errors=True)
    shutil.rmtree(C_ROOT, ignore_errors=True)
    shutil.rmtree(D_ROOT, ignore_errors=True)
    os.makedirs(C_ROOT, exist_ok=True)
    os.makedirs(D_ROOT, exist_ok=True)
    for name in ("f1.txt", "big.bin", "stale.bin"):
        src = os.path.join(A_ROOT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(C_ROOT, name))

    extra = [
        "--force-relay",
        "--relay-key=" + relay_info["key"],
        "--relay-host=" + relay_info["host"],
    ]
    hello = {
        "forceRelay": True,
        "customRelay": {"keyHex": relay_info["key"], "host": relay_info["host"]},
    }
    seed_c = "33" * 32
    seed_d = "44" * 32
    c = Node("C", C_DIR, seed_c, "C-box", extra_args=extra, hello_extra=hello)
    d = Node("D", D_DIR, seed_d, "D-box", extra_args=extra, hello_extra=hello)
    rc, rd = pair_and_roots(c, d, C_ROOT, D_ROOT, "Croot", "Droot")
    ctype = connection_type(c, d.device_id)
    log("relay pairing connectionType C->D", ctype)
    assert ctype == "relay", "expected forced relay, got %r" % ctype

    copied = d.req("fs.copy", {
        "destination": {"rootId": rd["rootId"], "relativePath": "relay-got"},
        "items": [{"source": {"peerId": c.device_id, "rootId": rc["rootId"], "relativePath": size_name}}],
        "collision": "rename",
    }, timeout=120)
    assert copied.get("ok"), copied
    op = copied["result"]["operationIds"][0]
    d.wait_event(
        lambda e: e.get("event") == "operation.progress" and e["payload"].get("operationId") == op and e["payload"].get("bytesDone", 0) > progress_need,
        "relay progress",
        timeout,
    )
    d.wait_event(
        lambda e: e.get("event") == "operation.state" and e["payload"].get("operationId") == op and e["payload"].get("state") == "done",
        "relay GET done",
        timeout,
    )
    dst = os.path.join(D_ROOT, "relay-got", size_name)
    assert sha(dst) == expect_sha
    assert blake256(dst) == expect_blake
    assert connection_type(d, c.device_id) == "relay"
    with open(os.path.join(BASE, "relay-stats.json"), encoding="utf-8") as fh:
        stats = json.load(fh)
    assert stats["pairings"]["matched"] > 0 and stats["streams"]["opened"] > 0, stats
    assert stats["bytesReceived"] >= os.path.getsize(dst), "file bytes did not traverse the actual relay: %r" % stats
    log("actual relay pairings and streams", stats["pairings"]["matched"], stats["streams"]["opened"])
    log("actual relay received bytes", stats["bytesReceived"])
    log("forced-relay GET verified (%s) [ok]" % size_name)
    c.stop()
    d.stop()


def main():
    fx = make_fixtures()
    relay_proc = None
    try:
        if "--relay-only" not in FLAGS:
            run_direct(fx)
        else:
            log("direct phase skipped (--relay-only)")
        if WANT_RELAY:
            relay_proc, info = start_local_relay()
            run_relay(fx, info)
        else:
            log("relay phase skipped (E2E_RELAY=0)")
        log("\n==== E2E PASS ====")
    finally:
        if relay_proc is not None:
            try:
                relay_proc.terminate()
                relay_proc.wait(timeout=5)
            except Exception:
                try:
                    relay_proc.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    try:
        main()
    finally:
        for node in reversed(_owned_nodes):
            node.stop(graceful=False)
