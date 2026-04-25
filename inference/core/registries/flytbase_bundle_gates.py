"""Load-time gates for `bundle://` model loads.

Two gates run after URI resolution but before staging:

1. **License gate** (D10) — refuses to load `restricted` bundles on
   devices not allow-listed for the license class. Default off; flip
   on with `FLYTBASE_LICENSE_GATE_ENABLED=1`.

2. **Signature gate** — re-runs Studio's Ed25519 verify against the
   staged manifest. Trusted public keys live in a YAML file at
   `$FLYTBASE_TRUSTED_KEYS_FILE` (default
   `/etc/flytbase/trusted_signers.yaml`). Default off; flip on with
   `FLYTBASE_SIGNATURE_VERIFY_ENABLED=1`.

Production-grade replacement (Phase B, gated on Bundle Signing Service
#3): the trusted-keys table is fetched from the service via short-TTL
cache instead of local YAML. Signer scheme moves from
`ed25519-prototype` to whatever the service publishes.

Both gates fail closed by design — if the kill switches are enabled and
the bundle doesn't match policy, the load is refused with a clear
operator-actionable message.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict, List

import yaml

from inference.core.exceptions import ModelNotRecognisedError


class BundleLicenseRefusedError(ModelNotRecognisedError):
    """Raised when a `bundle://` load is blocked by the license gate."""


class BundleSignatureRefusedError(ModelNotRecognisedError):
    """Raised when a `bundle://` load is blocked by the signature gate."""


def _flag(name: str) -> bool:
    return os.environ.get(name, "0") == "1"


def _csv_env(name: str) -> List[str]:
    return [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]


def check_license(manifest: Dict[str, Any]) -> None:
    """Enforce D10 on the bundle's `license.runtime_compatibility`.

    Kill switch: `FLYTBASE_LICENSE_GATE_ENABLED=0` bypasses this gate
    entirely (rollout default).

    Behavior when enabled:
      - `open`: always loads.
      - `restricted`: loads iff `FLYTBASE_DEVICE_TENANT_ID` ∈
        `FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST`.
      - `unknown`: refuses unless `FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN=1`
        (legacy-bundle escape valve).
      - anything else: refuses.
    """
    if not _flag("FLYTBASE_LICENSE_GATE_ENABLED"):
        return

    license_block = manifest.get("license") or {}
    rc = license_block.get("runtime_compatibility", "unknown")

    if rc == "open":
        return

    if rc == "unknown":
        if _flag("FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN"):
            return
        raise BundleLicenseRefusedError(
            "bundle has license.runtime_compatibility='unknown'; "
            "set FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN=1 to permit legacy "
            "bundles missing this field, or republish with an explicit "
            "license tag."
        )

    if rc == "restricted":
        device_tenant = os.environ.get("FLYTBASE_DEVICE_TENANT_ID", "")
        allowlist = _csv_env("FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST")
        if device_tenant and device_tenant in allowlist:
            return
        raise BundleLicenseRefusedError(
            f"bundle has license.runtime_compatibility='restricted'; "
            f"this device (FLYTBASE_DEVICE_TENANT_ID={device_tenant!r}) "
            f"is not in FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST={allowlist!r}. "
            f"Contact the FlytBase legal team to add this tenant to the "
            f"allow-list, or republish using an Apache-licensed labeler."
        )

    raise BundleLicenseRefusedError(
        f"bundle has unrecognised license.runtime_compatibility={rc!r}; "
        f"expected one of 'open', 'restricted', 'unknown'."
    )


def _trusted_keys_path() -> Path:
    return Path(
        os.environ.get(
            "FLYTBASE_TRUSTED_KEYS_FILE", "/etc/flytbase/trusted_signers.yaml"
        )
    )


def _load_trusted_keys() -> Dict[str, Dict[str, Any]]:
    path = _trusted_keys_path()
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text()) or {}
    return data.get("keys") or {}


def _canonical_payload(manifest: Dict[str, Any]) -> bytes:
    """Mirror `studio_cli.py:_canonical_signing_bytes` /
    `verify_bundle._verify_ed25519_signature`. The signer's signature
    field is blanked before serialisation; everything else is included.
    """
    m = copy.deepcopy(manifest)
    if "signer" in m and isinstance(m["signer"], dict):
        m["signer"]["signature"] = None
    return json.dumps(m, sort_keys=True, default=str).encode("utf-8")


def verify_signature(manifest: Dict[str, Any]) -> None:
    """Re-run Ed25519 verification on the bundle's manifest.

    Kill switch: `FLYTBASE_SIGNATURE_VERIFY_ENABLED=0` bypasses (rollout
    default).
    """
    if not _flag("FLYTBASE_SIGNATURE_VERIFY_ENABLED"):
        return

    signer = manifest.get("signer") or {}
    scheme = signer.get("scheme")
    key_id = signer.get("key_id")
    sig_hex = signer.get("signature")

    if scheme != "ed25519-prototype":
        raise BundleSignatureRefusedError(
            f"bundle signer.scheme={scheme!r}; only 'ed25519-prototype' is "
            f"trusted in this rollout. Production: scheme moves to whatever "
            f"Bundle Signing Service #3 publishes."
        )
    if not key_id:
        raise BundleSignatureRefusedError("bundle is missing signer.key_id.")
    if not sig_hex:
        raise BundleSignatureRefusedError("bundle is missing signer.signature.")

    keys = _load_trusted_keys()
    entry = keys.get(key_id)
    if entry is None:
        raise BundleSignatureRefusedError(
            f"bundle signed by key_id={key_id!r} which is not in the trusted "
            f"keys file at {_trusted_keys_path()}. Add the key to the file or "
            f"swap the file via FLYTBASE_TRUSTED_KEYS_FILE."
        )
    pem = entry.get("pem")
    if not pem:
        raise BundleSignatureRefusedError(
            f"trusted-keys entry {key_id!r} has no `pem` field."
        )

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization

    pub = serialization.load_pem_public_key(pem.encode("utf-8"))
    payload = _canonical_payload(manifest)
    try:
        pub.verify(bytes.fromhex(sig_hex), payload)
    except InvalidSignature as exc:
        raise BundleSignatureRefusedError(
            f"signature verification FAILED for bundle signed by "
            f"key_id={key_id!r}. The manifest may have been tampered with, "
            f"or the trusted-keys entry has the wrong public key."
        ) from exc
