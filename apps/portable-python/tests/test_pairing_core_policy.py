import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


class PairingCorePolicyTests(unittest.TestCase):
    def _read(self, rel):
        with open(os.path.join(APP, rel), encoding="utf-8") as fh:
            return fh.read()

    def test_portable_pairing_delegates_to_reference_coordinator(self):
        src = self._read("packages/core/src/portable/peers.ts")
        self.assertIn("import { PairingCoordinator }", src)
        self.assertIn("private _pairCoordinator: PairingCoordinator | null", src)
        self.assertIn("const coordinator = this._ensurePairCoordinator()", src)
        self.assertIn("const reply = await coordinator.host()", src)
        self.assertIn("await coordinator.join(topic)", src)
        self.assertIn("identityStore: this.topicKeys", src)
        self.assertIn("private async _peerInfo(", src)
        self.assertNotIn("new TransferSwarm", src)
        self.assertNotIn("new RememberCoordinator", src)

    def test_pairing_keeps_reference_dht_lifecycle(self):
        src = self._read("packages/core/src/portable/peers.ts")
        swarm = self._read("packages/core/src/worklet/transfer/swarm.ts")
        coordinator = self._read("packages/core/src/worklet/peers/pairing-coordinator.ts")
        self.assertIn("void this._watchSearch(epoch, 180_000)", src)
        self.assertIn("void this._watchSearch(epoch, 120_000)", src)
        self.assertIn("event: 'expired'", src)
        self.assertIn("reason: 'search-timeout'", src)
        self.assertIn("await this.swarm.flushAnnouncement()", coordinator)
        self.assertIn("await this.swarm.recycleTopic()", coordinator)
        self.assertIn("void this.swarm.refreshDiscovery()", coordinator)
        self.assertIn("async flushAnnouncement()", swarm)
        self.assertIn("async recycleTopic()", swarm)
        self.assertIn("async refreshDiscovery()", swarm)
        self.assertIn("this.swarm.startLanDiscovery()", coordinator)
        self.assertIn("startLanDiscovery(): void", swarm)
        self.assertIn("connectKnownPeer(publicKey: Uint8Array, host: string, dhtPorts:", swarm)
        self.assertIn("swarm.join(discovery, { server: true, client: true })", swarm)
        self.assertNotIn("swarm.join(discovery, { server: true, client: false })", swarm)
        self.assertNotIn("await this.swapKeyPair", swarm)
        self.assertIn("{ identityStore: deps.identityStore, bootstrap: deps.bootstrap }", coordinator)
        gui = self._read("apps/portable-python/gui/main_window.py")
        self.assertIn('event == "expired"', gui)
        self.assertIn('t("pair_timeout")', gui)
        i18n = self._read("apps/portable-python/gui/i18n.py")
        self.assertIn("Устройство не найдено. Поиск остановлен.", i18n)

    def test_persistent_rendezvous_uses_lan_beacon(self):
        src = self._read("packages/core/src/portable/peers.ts")
        lan = self._read("packages/core/src/worklet/peers/lan-pair.ts")
        self.assertIn("LAN_RENDEZVOUS_PORT", src)
        self.assertIn("this._ensureLanRendezvous()", src)
        self.assertIn("connectLanSwarmPeer(", src)
        self.assertIn("pairLog('rendezvous join'", src)
        self.assertIn("pairLog('rendezvous lan beacon')", src)
        self.assertIn("pairLog('persistent connected'", src)
        self.assertIn("socket.on('error'", src)
        self.assertIn("const status = swarm.status(crypto.discoveryKey", src)
        self.assertIn("if (status && typeof status.refresh === 'function') await status.refresh()", src)
        self.assertNotIn("_reinforceRendezvous(topicHex, 120_000)", src)
        self.assertIn("export const LAN_RENDEZVOUS_PORT = 48738", lan)
        self.assertIn("export const LAN_PAIR_PORT = 48737", lan)

    def test_pairing_requires_host_confirmation(self):
        src = self._read("packages/core/src/portable/peers.ts")
        gui = self._read("apps/portable-python/gui/main_window.py")
        e2e = self._read("scripts/e2e-two-cores.py")
        self.assertIn("autoRememberVote: false", src)
        self.assertIn("PAIR_CONFIRM_TIMEOUT_MS = 60_000", src)
        self.assertIn("event: 'request'", src)
        self.assertIn("evt.devicePubkey", src)
        self.assertIn("show_pair_request", gui)
        self.assertIn('"pairing.accept"', gui)
        self.assertIn('a.req("pairing.accept"', e2e)
        self.assertIn('e["payload"].get("event") == "confirmed"', e2e)

    def test_pairing_reset_is_explicit_session_teardown(self):
        src = self._read("packages/core/src/portable/peers.ts")
        reset = src.split("async pairReset(): Promise<void>")[1].split("// ---------- peer management ----------")[0]
        self.assertIn("this._pairEpoch += 1", reset)
        self.assertIn("await coordinator?.destroy()", reset)
        self.assertIn("this._pairCoordinator = null", reset)


if __name__ == "__main__":
    unittest.main()
