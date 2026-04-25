# [phase-3] LocalONNXModel + load-time license & signature gates for `bundle://`

## Why

PR #1 ([`flytbase_bundle_registry.md`](./flytbase_bundle_registry.md), merged
2026-04-25 as `3599af481` on `phase-1-spike`) shipped the `bundle://`
URI resolver but explicitly stops short of *loading* the resolved file —
`FlytBaseBundleRegistry.get_model` raises `BundleResolutionError` with
the local path and a "wait for the LocalONNXModel adapter" message.

This PR ships that adapter, plus the two production gates the resolver
PR explicitly deferred:

1. **License-class gating per D10** — refuse to load `restricted`
   bundles on devices not allow-listed for the license class.
2. **Ed25519 signature verification at load** — re-runs Studio's
   `verify_bundle._verify_ed25519_signature` against the staged
   manifest before constructing the model.

This unblocks SAM 3 default at Studio (Phase A Finding 4-bis) by
giving Edge a defensible refusal path for `restricted` bundles on
non-allow-listed tenants. Without this PR, a SAM-3-distilled bundle
with `runtime_compatibility: restricted` has no enforcement point on
the Edge side — D10 is a contract Studio can attest to but Edge can't
enforce.

## What

Three additions, each behind its own kill switch:

### 1. `inference/core/models/local_onnx.py` — new

`LocalONNXModel(local_weights_path, manifest, task_type)`. Wraps an
ONNX file into an `OnnxRoboflowInferenceModel`-compatible class
without going through the Roboflow API metadata path. Reads
`input_resolution`, `classes`, `model_architecture` from the bundle
manifest instead.

`FlytBaseBundleRegistry.get_model` now returns this instead of raising:

```python
def get_model(self, model_id, api_key="", **kwargs):
    if model_id.startswith("bundle://"):
        local_path = resolve_bundle_uri(model_id)
        bundle_root = _bundle_root_for(model_id)
        manifest = _load_manifest(bundle_root)
        _check_license(manifest)            # gate #1
        _verify_signature(bundle_root, manifest)   # gate #2
        return LocalONNXModel(local_path, manifest, ...)
    return self._wrapped.get_model(model_id, api_key, **kwargs)
```

### 2. License gate — `_check_license(manifest)`

Reads `manifest.license.runtime_compatibility ∈ {open, restricted, unknown}`.

| Value | Behavior |
|---|---|
| `open` | always loads |
| `restricted` | loads iff `tenant_id` ∈ `FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST` (env: comma-separated tenant IDs; long-term: read from config file) |
| `unknown` | refuses unless `FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN=1` (Phase B legal escape valve for legacy bundles missing the field) |

Refusal raises `BundleLicenseRefusedError` with a clear message
naming the license class and the allow-list contact. Kill switch:
`FLYTBASE_LICENSE_GATE_ENABLED=0` bypasses the gate entirely (Phase B
default off until allow-list infra ships).

### 3. Signature gate — `_verify_signature(bundle_root, manifest)`

Re-runs the Ed25519 check Studio's `verify_bundle.py` does at publish
time, against the staged manifest:

- Reads `manifest.signer.{scheme, key_id, signature}`
- Looks up the public key for `key_id` in the trusted-keys table
- Re-canonicalises the manifest (signer.signature blanked) and verifies

Trusted-keys table format — YAML at
`$FLYTBASE_TRUSTED_KEYS_FILE` (default `/etc/flytbase/trusted_signers.yaml`):

```yaml
keys:
  d1958721e59ffb38:
    scheme: ed25519-prototype
    pem: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEA...
      -----END PUBLIC KEY-----
    note: "Studio Phase A prototype key"
```

Refusal raises `BundleSignatureRefusedError`. Kill switch:
`FLYTBASE_SIGNATURE_VERIFY_ENABLED=0` bypasses (rollout default).

Production-grade replacement (Phase B, gated on Bundle signing
service #3): the trusted-keys table is fetched from the service via
short-TTL cache instead of local YAML. Signer scheme moves from
`ed25519-prototype` to whatever the service publishes.

## Activation

**Status (2026-04-26 update): both gates default ON when the bundle
registry is enabled.** `gpu_http.py` runs `os.environ.setdefault(
"FLYTBASE_LICENSE_GATE_ENABLED", "1")` and the same for
`FLYTBASE_SIGNATURE_VERIFY_ENABLED` inside the
`FLYTBASE_BUNDLE_REGISTRY_ENABLED=1` block. Opting into bundle loading
opts you into the gates that protect it — secure-by-default for the
opted-in path. Either gate can still be explicitly disabled by
exporting the env var as `0` before container start (emergency escape
valve).

Operator must provision before opting in:
- `$FLYTBASE_TRUSTED_KEYS_FILE` (default
  `/etc/flytbase/trusted_signers.yaml`) — populate with the public PEM
  for every signing key the deployment trusts. Without this, signed
  bundles refuse to load.
- `$FLYTBASE_DEVICE_TENANT_ID` + `$FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST`
  — only required if the deployment will load `restricted` bundles.

Env summary:

```
FLYTBASE_BUNDLE_REGISTRY_ENABLED=1                            # explicit opt-in
# auto-enabled by gpu_http.py when ENABLED=1, override with =0:
FLYTBASE_LICENSE_GATE_ENABLED=1                               # D10 enforcement
FLYTBASE_SIGNATURE_VERIFY_ENABLED=1                           # signature check
# operator-supplied:
FLYTBASE_TRUSTED_KEYS_FILE=/etc/flytbase/trusted_signers.yaml # default path
FLYTBASE_DEVICE_TENANT_ID=drone-fleet-prod-7                  # for restricted
FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST=drone-fleet-prod-7,...  # for restricted
FLYTBASE_LICENSE_GATE_ALLOW_UNKNOWN=1                         # legacy bundles
```

For the gpu_http startup wiring, the gate enablement happens at the
same site as the registry wrap so the two coupling decisions live in
one place. The gates themselves live inside
`FlytBaseBundleRegistry.get_model`, not at registry construction.

## Companion (Studio repo)

- **`air_studio/prototype/verify_bundle.py`** — the
  `_verify_ed25519_signature(manifest, public_key_path)` function
  becomes a public API (rename to `verify_ed25519_signature`). This
  PR's `_verify_signature` reuses the same canonicalisation logic
  rather than duplicating it.
- **`air_studio/prototype/keys/public.pem`** — the Phase A prototype
  public key. Drop into `trusted_signers.yaml` under
  `key_id: d1958721e59ffb38` to allow the staged Phase A bundles to
  load with the signature gate on.
- **`studio_cli.py keygen`** already produces the keypair format this
  PR expects (`PEM`, Ed25519, key_id derived from public-key SHA-256
  prefix).

## Tests

`tests/inference/unit_tests/core/registries/test_flytbase_bundle_load_gates.py`
covers 12+ cases:

```text
# License gate
[ok] open license, gate enabled       → loads
[ok] open license, gate disabled      → loads
[ok] restricted, tenant in allowlist  → loads
[ok] restricted, tenant not in list   → refuses (BundleLicenseRefusedError)
[ok] restricted, gate disabled        → loads (kill switch off)
[ok] unknown, allow_unknown=1         → loads
[ok] unknown, allow_unknown=0         → refuses

# Signature gate
[ok] signed by trusted key            → loads
[ok] signer.scheme not "ed25519-prototype" → refuses
[ok] key_id not in trusted-keys table → refuses
[ok] tampered manifest (sig invalid)  → refuses (BundleSignatureRefusedError)
[ok] missing signer.signature         → refuses
[ok] gate disabled                    → loads (kill switch off)

# Integration
[ok] both gates on, end-to-end happy  → loads
[ok] non-bundle model_id              → unchanged path (wrapped registry)
```

## What this PR does NOT do (gated on later sign-off)

| Item | Belongs to |
|---|---|
| **LRU cache eviction** per-(template, version) on `$FLYTBASE_BUNDLE_CACHE_DIR` | Phase 4 cache-mgmt PR — append-only is fine for Phase A and B with operator-managed cleanup |
| **`contextvars` for short-form URI multi-tenancy** (replaces `FLYTBASE_ACTIVE_BUNDLE_ROOT` env) | Multi-tenant worker PR — current env-var works for single-tenant deployments |
| **BYOM bundles where `provenance.distillation_target: (none)`** — register via AutoModel `from_pretrained(..., model_type=..., task_type=...)` overrides | Phase B Path B PR — needs the `inference_models` package present in the container (today's `flytbase-infer:v122-blackwell` image doesn't ship it) |
| **TRT engine packages per target** (D20) | Phase B BYOM hardware-target PR |

These are the four "NOT in this PR" items from the original resolver
PR. This load-gates PR addresses two of the four (license + signature);
the others get follow-up PRs in the same series.

## Smoke checklist for reviewers

1. `pytest tests/inference/unit_tests/core/registries/test_flytbase_bundle_load_gates.py`
2. **No-regression**: with all gates *off*, a non-bundle workflow still
   validates: `POST /workflows/validate` on a `yolov8n-640`-based
   workflow returns `{"status":"ok"}`.
3. **Gate-off path**: stage a Phase A bundle, set
   `FLYTBASE_BUNDLE_REGISTRY_ENABLED=1` only, validate the bundle's
   workflow.json — should return `{"status":"ok"}` (no gate is checked).
4. **Gate-on path**: set both gate env flags + populate
   `trusted_signers.yaml` with the Phase A public key. Validate the
   bundle's workflow.json — still `{"status":"ok"}` because the bundle
   is `runtime_compatibility: open` and signed by the trusted key.
5. **Refusal paths**:
   - Stage a manifest with `license.runtime_compatibility: restricted`,
     no allow-list entry. Validate → `BundleLicenseRefusedError` with
     a tenant-actionable message.
   - Tamper one byte of a staged manifest, re-stage, validate →
     `BundleSignatureRefusedError`.

## Sign-off needed

- **Edge runtime owner** — gate placement at
  `FlytBaseBundleRegistry.get_model` is the right boundary;
  `LocalONNXModel` shape matches the rest of the
  `OnnxRoboflowInferenceModel` family.
- **Legal (D6)** — confirms the trusted-keys table is the right
  enforcement point for derivative-work refusals on SAM-3-distilled
  bundles. With this PR merged + `FLYTBASE_LICENSE_GATE_ENABLED=1` +
  empty `FLYTBASE_RESTRICTED_LICENSE_ALLOWLIST`, a `restricted`
  bundle cannot load anywhere — that is the kill switch Legal needs
  before SAM 3 default ships.
- **Bundle signing service #3 owner** — confirms the
  `signer.{scheme, key_id, signature}` field shape this PR consumes
  matches the service's planned output, so the Phase B swap (local
  YAML → service fetch) is a credential-source change, not a
  protocol change.

## Risks

- **Allow-list misconfig blocks legit bundles** — the gate fails
  closed by design. Mitigation: kill switch defaults off during
  rollout; allow-list is loaded once at startup with a clear log line.
- **Trusted-keys YAML drift across the fleet** — Phase B's switch to
  Bundle signing service #3 fixes this. Phase A bridge: the YAML
  ships with the Edge container image, so it tracks releases.
- **Performance**: signature verification adds one Ed25519 verify per
  model load (~1ms). Negligible relative to ONNX session construction.
- **Gate ordering**: license check first (cheap, no I/O), signature
  check second (reads + hashes manifest). A bundle that fails license
  refuses without spending I/O on signature.

## Future follow-ups in the same series (one-line specs)

- **Cache eviction PR** — add LRU policy on `$FLYTBASE_BUNDLE_CACHE_DIR`
  with `FLYTBASE_BUNDLE_CACHE_MAX_GB` env (default unset = no
  eviction, append-only). Eviction unit is `(template, version)` —
  evict the whole bundle dir, never individual files.
- **Multi-tenant URI binding PR** — replace `FLYTBASE_ACTIVE_BUNDLE_ROOT`
  env var with `contextvars.ContextVar` set per workflow execution.
  Allows a multi-tenant worker to serve bundle-A-short-URI and
  bundle-B-short-URI in parallel.
- **BYOM overrides PR** — extend `LocalONNXModel` to accept
  `model_type=` + `task_type=` constructor kwargs that override
  manifest values, for bundles where
  `provenance.distillation_target: (none)`. Pairs with the
  `inference_models` provider's existing override path so both
  routes behave identically.
- **TRT engine packages PR (D20)** — extend the bundle layout to
  include per-target `.engine` files, prefer them over ONNX when
  present and the host's TRT version matches.
