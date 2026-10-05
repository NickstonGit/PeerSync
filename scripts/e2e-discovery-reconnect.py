"""PeerSync portable — discovery/reconnect smoke.

Два PSNCore: pairing -> взаимный presence -> рестарт обоих процессов ->
фоновое переподключение только из персистентного состояния (remembered
peers + rendezvous topics + LAN beacon). Файлы/копирования не нужны.

    python scripts/e2e-discovery-reconnect.py [pathToCoreExe]

Env:
  DISC_TIMEOUT   таймаут reconnect presence в секундах (default 180)
"""

import os
import queue
import shutil
import sys
import time

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(APP, "apps", "portable-python"))

from ipc.core_client import CoreClient  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
CORE = ARGS[0] if ARGS else os.path.join(APP, "build", "core", "PSNCore.exe")
CORE = os.path.abspath(CORE)
BASE = os.path.join(APP, "build", "e2e-disc")
A_DIR = os.path.join(BASE, "A")
B_DIR = os.path.join(BASE, "B")
SEED_A = "11" * 32
SEED_B = "22" * 32
TIMEOUT = int(os.environ.get("DISC_TIMEOUT", "180"))


def log(*a):
    print(" ".join(str(x) for x in a), flush=True)


class Node:
    def __init__(self, tag, data_root, seed_hex, name):
        os.makedirs(data_root, exist_ok=True)
        for sub in ("peers", "topics", "journals", "chat", "logs"):
            os.makedirs(os.path.join(data_root, sub), exist_ok=True)
        self.client = CoreClient(
            CORE,
            data_root,
            os.path.join(data_root, "logs", "core.log"),
            "0.0.0",
            "e2e",
            extra_args=["--debug"],
        )
        self.events = queue.Queue()
        self.tag = tag

        def on_event(frame):
            self.events.put(frame)

        self.client.start(on_event)
        ack = self.client.request(
            "hello",
            {
                "shellProtocol": 1,
                "identitySeedHex": seed_hex,
                "deviceName": name,
                "deviceType": "desktop",
                "dataRoot": data_root,
            },
            timeout=60,
        )
        assert ack.get("ok"), ack
        self.device_id = ack["result"]["peerId"]
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

    def peers_online(self):
        reply = self.req("peer.list")
        assert reply.get("ok"), reply
        return {p["id"]: p.get("online") for p in reply["result"]["peers"]}

    def stop(self):
        try:
            self.client.stop(graceful=True, timeout=8)
        except Exception:
            pass


def is_presence_online(peer_id):
    return (
        lambda e: e.get("event") == "peer.presence"
        and e.get("payload", {}).get("id") == peer_id
        and e.get("payload", {}).get("online")
    )


def pair(a, b):
    code = a.req("pairing.createCode")["result"]["code"]
    assert len(code) == 64, code
    time.sleep(2)
    b.req("pairing.joinCode", {"code": code})
    request = a.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e.get("payload", {}).get("event") == "request",
        "A host confirmation request",
        120,
    )
    pending_id = request["payload"].get("pendingId")
    assert pending_id and len(pending_id) == 64, request
    a.req("pairing.accept", {"pendingId": pending_id, "mine": False})
    a.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e.get("payload", {}).get("event") == "confirmed",
        "A confirmed",
        120,
    )
    b.wait_event(
        lambda e: e.get("event") == "pairing.changed" and e.get("payload", {}).get("event") == "confirmed",
        "B confirmed",
        120,
    )


def wait_mutual_presence(a, b, timeout, label):
    a.wait_event(is_presence_online(b.device_id), label + ": A sees B", timeout)
    b.wait_event(is_presence_online(a.device_id), label + ": B sees A", timeout)


def main():
    if not os.path.exists(CORE):
        raise SystemExit("core not found: " + CORE)
    shutil.rmtree(BASE, ignore_errors=True)

    a = Node("A", A_DIR, SEED_A, "A-box")
    b = Node("B", B_DIR, SEED_B, "B-box")
    log("hello A", a.device_id[:12], "B", b.device_id[:12])
    pair(a, b)
    log("pairing confirmed")
    wait_mutual_presence(a, b, 120, "fresh pair")
    log("fresh pair presence OK; online:", a.peers_online(), b.peers_online())

    a.stop()
    b.stop()
    time.sleep(3)
    log("both stopped; restarting...")

    a2 = Node("A2", A_DIR, SEED_A, "A-box")
    b2 = Node("B2", B_DIR, SEED_B, "B-box")
    log("restarted A2", a2.device_id[:12], "B2", b2.device_id[:12])
    assert a2.device_id == a.device_id, "device identity rotated for A"
    assert b2.device_id == b.device_id, "device identity rotated for B"
    try:
        wait_mutual_presence(a2, b2, TIMEOUT, "reconnect")
    except AssertionError:
        log("peer.list A2:", a2.peers_online())
        log("peer.list B2:", b2.peers_online())
        raise
    log("reconnect presence OK; online:", a2.peers_online(), b2.peers_online())
    a2.stop()
    b2.stop()
    log("")
    log("==== DISCOVERY RECONNECT PASS ====")


if __name__ == "__main__":
    main()
