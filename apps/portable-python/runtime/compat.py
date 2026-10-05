"""Compatibility identifiers preserved across PeerSync releases.

Most constants in this module are exact legacy bytes used by the transport or
persisted Windows state. They are intentionally centralized so product branding
can evolve without silently rotating identities, breaking old peer sessions or
making previously written state unreadable.
"""

IDENTITY_ENTROPY = b"altersend.identity.v1"

# New PeerSync sidecars are written with the PeerSync schema. The old schema is
# still accepted so previously signed metadata can be validated during rollout.
UPDATE_MANIFEST_SCHEMA = "peersync-update-v1"
LEGACY_UPDATE_MANIFEST_SCHEMA = "altersend-update-v1"
UPDATE_MANIFEST_SCHEMAS = frozenset((UPDATE_MANIFEST_SCHEMA, LEGACY_UPDATE_MANIFEST_SCHEMA))

# Exact Windows names retained for cross-version exclusion/state compatibility.
INSTANCE_MUTEX_PREFIX = "Global\\AlterSend.App."
INSTANCE_EVENT_PREFIX = "Global\\AlterSend.Show."
INSTANCE_LOCK_NAME = ".altersend-instance.lock"
