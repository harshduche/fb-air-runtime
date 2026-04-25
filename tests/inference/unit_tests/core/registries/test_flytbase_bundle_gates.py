"""Tests for the load-time license + signature gates."""

import copy
import json
from pathlib import Path

import pytest
import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from inference.core.registries.flytbase_bundle_gates import (
    BundleLicenseRefusedError,
    BundleSignatureRefusedError,
    _canonical_payload,
    check_license,
    verify_signature,
)


# ---------------------------------------------------------------- license


def _manifest(rc: str | None = "open") -> dict:
    m = {"template": {"name": "t", "version": "0.1.0"}}
    if rc is not None:
        m["license"] = {"runtime_compatibility": rc}
    return m


def test_license_gate_off_skips_check(monkeypatch):
    monkeypatch.delenv("FLYTBASE_LICENSE_GATE_ENABLED", raising=False)
    # `restricted` would normally be refused — but gate is off, so allowed.
    check_license(_manifest("restricted"))


def test_license_open_loads_with_gate_on(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    check_license(_manifest("open"))


def test_license_restricted_with_tenant_in_allowlist_loads(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.setenv("FLYTBASE_DEVICE_TENANT_ID", "drone-fleet-7")
    monkeypatch.setenv(
        "FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST", "drone-fleet-7,drone-fleet-9"
    )
    check_license(_manifest("restricted"))


def test_license_restricted_with_tenant_missing_refuses(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.setenv("FLYTBASE_DEVICE_TENANT_ID", "drone-fleet-3")
    monkeypatch.setenv(
        "FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST", "drone-fleet-7"
    )
    with pytest.raises(BundleLicenseRefusedError) as ei:
        check_license(_manifest("restricted"))
    assert "drone-fleet-3" in str(ei.value)
    assert "drone-fleet-7" in str(ei.value)


def test_license_restricted_with_no_tenant_id_refuses(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.delenv("FLYTBASE_DEVICE_TENANT_ID", raising=False)
    monkeypatch.setenv("FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST", "anyone")
    with pytest.raises(BundleLicenseRefusedError):
        check_license(_manifest("restricted"))


def test_license_unknown_refuses_by_default(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.delenv("FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN", raising=False)
    with pytest.raises(BundleLicenseRefusedError):
        check_license(_manifest("unknown"))


def test_license_unknown_allowed_with_escape_valve(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN", "1")
    check_license(_manifest("unknown"))


def test_license_missing_block_treated_as_unknown(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    monkeypatch.delenv("FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN", raising=False)
    with pytest.raises(BundleLicenseRefusedError):
        check_license(_manifest(rc=None))


def test_license_invalid_value_refuses(monkeypatch):
    monkeypatch.setenv("FLYTBASE_LICENSE_GATE_ENABLED", "1")
    with pytest.raises(BundleLicenseRefusedError):
        check_license(_manifest("commercial"))


# ---------------------------------------------------------------- signature


@pytest.fixture
def signing_setup(tmp_path, monkeypatch):
    """Generate a real Ed25519 keypair, sign a manifest, write the public
    key to a trusted-keys YAML, and return the signed manifest + helpers
    so individual tests can mutate before calling verify_signature."""
    private = Ed25519PrivateKey.generate()
    public = private.public_key()
    pem = public.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    key_id = "phaseA-test-key"
    keys_file = tmp_path / "trusted_signers.yaml"
    keys_file.write_text(yaml.safe_dump({"keys": {key_id: {
        "scheme": "ed25519-prototype",
        "pem": pem,
        "note": "test key",
    }}}))

    manifest = {
        "template": {"name": "t", "version": "0.1.0"},
        "license": {"runtime_compatibility": "open"},
        "signer": {
            "scheme": "ed25519-prototype",
            "key_id": key_id,
            "signature": None,
        },
    }
    payload = _canonical_payload(manifest)
    manifest["signer"]["signature"] = private.sign(payload).hex()

    monkeypatch.setenv("FLYTBASE_SIGNATURE_VERIFY_ENABLED", "1")
    monkeypatch.setenv("FLYTBASE_TRUSTED_KEYS_FILE", str(keys_file))

    return {
        "manifest": manifest,
        "key_id": key_id,
        "keys_file": keys_file,
        "private": private,
    }


def test_signature_gate_off_skips_check(monkeypatch, signing_setup):
    monkeypatch.setenv("FLYTBASE_SIGNATURE_VERIFY_ENABLED", "0")
    # Mangle the signature; with gate off, it doesn't matter.
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["signer"]["signature"] = "00" * 64
    verify_signature(bad)


def test_signature_valid_signature_loads(signing_setup):
    verify_signature(signing_setup["manifest"])


def test_signature_unknown_scheme_refuses(signing_setup):
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["signer"]["scheme"] = "rsa-2048"
    with pytest.raises(BundleSignatureRefusedError) as ei:
        verify_signature(bad)
    assert "rsa-2048" in str(ei.value)


def test_signature_unsigned_prototype_refuses(signing_setup):
    """Studio Phase A wrote `signer.scheme: unsigned-prototype` early on —
    those bundles must NOT pass when the gate is enabled."""
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["signer"]["scheme"] = "unsigned-prototype"
    with pytest.raises(BundleSignatureRefusedError):
        verify_signature(bad)


def test_signature_unknown_key_id_refuses(signing_setup):
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["signer"]["key_id"] = "some-other-key"
    with pytest.raises(BundleSignatureRefusedError) as ei:
        verify_signature(bad)
    assert "some-other-key" in str(ei.value)


def test_signature_missing_signature_refuses(signing_setup):
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["signer"]["signature"] = None
    with pytest.raises(BundleSignatureRefusedError):
        verify_signature(bad)


def test_signature_tampered_manifest_refuses(signing_setup):
    """Modifying any field invalidates the signature."""
    bad = copy.deepcopy(signing_setup["manifest"])
    bad["template"]["version"] = "0.2.0"  # tamper a field outside `signer`
    with pytest.raises(BundleSignatureRefusedError):
        verify_signature(bad)


def test_signature_missing_keys_file_refuses(monkeypatch, signing_setup):
    monkeypatch.setenv(
        "FLYTBASE_TRUSTED_KEYS_FILE", "/nonexistent/trusted_signers.yaml"
    )
    with pytest.raises(BundleSignatureRefusedError):
        verify_signature(signing_setup["manifest"])


def test_signature_canonical_payload_blanks_signature_field():
    """The canonicalisation must blank `signer.signature` so the payload
    is the same before and after signing."""
    m1 = {"signer": {"signature": None, "key_id": "k"}, "x": 1}
    m2 = {"signer": {"signature": "deadbeef", "key_id": "k"}, "x": 1}
    assert _canonical_payload(m1) == _canonical_payload(m2)
    # And the canonical form is sorted JSON
    decoded = json.loads(_canonical_payload(m2))
    assert decoded["signer"]["signature"] is None
