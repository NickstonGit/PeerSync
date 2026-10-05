"""Coalesced `peer.list` refresher.

Presence events arrive per peer per state change, and a flapping peer can emit
a burst of them. Issuing one RPC per event floods the Core and the pipe for data
that a single response already summarises, so refreshes are coalesced: while one
is in flight, further requests set a pending flag and at most one follow-up runs
when the current call settles.

This module holds no Tk state so the coalescing rules can be unit tested
without constructing the window.
"""


class PeerListRefresher:
    """Serialize peer-list refreshes and collapse bursts into one follow-up."""

    def __init__(self, call, now=None):
        """`call(stamp, done, on_ok, on_err)` issues one request.

        `done` must be invoked exactly once when the request settles, from
        either callback, so a failed request still releases the in-flight slot.
        """
        self._call = call
        self._stamp = 0
        self._inflight = False
        self._pending = False
        self._pending_options = None

    @property
    def stamp(self):
        return self._stamp

    @property
    def inflight(self):
        return self._inflight

    @property
    def pending(self):
        return self._inflight or self._pending

    def request(self, **options):
        """Ask for a refresh. Returns True when an RPC was actually issued."""
        if self._inflight:
            self._pending = True
            # Options are merged so a follow-up never loses a request that
            # asked for more than the one currently in flight.
            self._pending_options = dict(self._pending_options or {}, **options)
            return False

        self._inflight = True
        self._pending = False
        self._pending_options = None
        self._stamp += 1
        stamp = self._stamp

        def settle():
            self._inflight = False
            if not self._pending:
                self._pending_options = None
                return
            follow_up = self._pending_options or {}
            self._pending = False
            self._pending_options = None
            self.request(**follow_up)

        def on_ok(result):
            try:
                if stamp == self._stamp:
                    options.get("on_ok", lambda _r: None)(result)
            finally:
                settle()

        def on_err(error):
            try:
                if stamp == self._stamp:
                    options.get("on_err", lambda _e: None)(error)
            finally:
                settle()

        self._call(stamp, settle, on_ok, on_err)
        return True

    def reset(self):
        """Abandon in-flight state after the Core owner changes."""
        self._stamp += 1
        self._inflight = False
        self._pending = False
        self._pending_options = None
