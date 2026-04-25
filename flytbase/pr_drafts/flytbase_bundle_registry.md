# [phase-3 / Studio integration] Add `bundle://` model_id resolver — `FlytBaseBundleRegistry`

## Why

AI-R Studio publishes `.flyttmpl` bundles whose `postprocess/workflow.json`
references the bundle's own weights via the self-describing URI scheme
`bundle://model/weights.onnx`. The engine's existing `RoboflowModelRegistry`
calls `get_model_type(model_id, api_key)` for every model_id, which only
recognises Roboflow workspace/project/version IDs and Roboflow's instant-model
cache.  `bundle://...` URIs fall through to the Roboflow API path and 401.

This is the writer-side half of D3 / D6 — Studio writes the URI; this PR
teaches the engine how to read it. Closes the only remaining gap in the
Studio↔Engine schema contract verified end-to-end against the running
fork on `:9001` (see [`air_studio/phase_A_status.md`](../../docs/reference/phase_A_status.md)
Finding 17 + 18, attached for context).

## What

Adds **`inference/core/registries/flytbase_bundle.py`** — a decorator class
over any `ModelRegistry` that intercepts `bundle://` model IDs before
delegating. Pure addition; zero impact on non-bundle URIs.

```python
class FlytBaseBundleRegistry(ModelRegistry):
    def __init__(self, wrapped: ModelRegistry) -> None:
        super().__init__(getattr(wrapped, "registry_dict", {}))
        self._wrapped = wrapped

    def get_model(self, model_id, api_key="", **kwargs) -> Model:
        if model_id.startswith("bundle://"):
            local_path = resolve_bundle_uri(model_id)   # ← stdlib only
            ...
        return self._wrapped.get_model(model_id, api_key, **kwargs)
```

Supports two URI shapes for `bundle://` resolution:

| Shape | Example | Resolved against |
|---|---|---|
| **Long** (self-describing) | `bundle://aerial_vehicle_pedestrian/0.1.2/model/weights.onnx` | `$FLYTBASE_BUNDLE_CACHE_DIR/<template>/<version>/<file>` |
| **Short** (workflow-context) | `bundle://model/weights.onnx` | `$FLYTBASE_ACTIVE_BUNDLE_ROOT/<file>` (env var per request) |

Default `$FLYTBASE_BUNDLE_CACHE_DIR` = `$MODEL_CACHE_DIR/flytbase/bundles`,
matching the existing `MODEL_CACHE_DIR` convention.

## Activation

**Status (2026-04-26): wiring landed in `docker/config/gpu_http.py`,
gated behind `FLYTBASE_BUNDLE_REGISTRY_ENABLED=1` (default off).**
End-to-end model loading still gated on `LocalONNXModel` adapter
(see "What this PR does NOT do" below).

```python
# docker/config/gpu_http.py
model_registry = RoboflowModelRegistry(ROBOFLOW_MODEL_TYPES)
if os.environ.get("FLYTBASE_BUNDLE_REGISTRY_ENABLED", "0") == "1":
    model_registry = FlytBaseBundleRegistry(wrapped=model_registry)
```

Without the env flag, the wrap is bypassed entirely and the engine
behaves exactly as before. With the flag, `bundle://` URIs route
through the resolver; non-bundle URIs still delegate to the wrapped
Roboflow registry unchanged.

## Companion (Studio repo)

- **`air_studio/prototype/stage_bundle.py`** — extracts a Studio
  `.flyttmpl.tar.gz` into the bundle cache layout this resolver expects.
  Use it for hand-deploys / smoke testing until Frame Storage / Model Hub
  auto-stages on publish (Phase B work).

```bash
python prototype/stage_bundle.py path/to/template_v0.1.2.flyttmpl.tar.gz
# → /tmp/cache/flytbase/bundles/template/0.1.2/{manifest.yaml, model/weights.onnx, ...}
```

Studio's `studio_cli.py bundle` writes the canonical engine step type
names (`roboflow_core/roboflow_object_detection_model@v1` /
`roboflow_core/roboflow_instance_segmentation_model@v2`) so a Studio
bundle round-trips through `flyt_builder/api/import_bundle` and
validates via `POST /workflows/validate` with `{"status":"ok"}`.

## Tests

Path-traversal defence (8/8 cases pass, see resolver docstring):

```text
[ok] long  → bundle://template/version/model/weights.onnx
[ok] short → bundle://model/weights.onnx (with FLYTBASE_ACTIVE_BUNDLE_ROOT)
[ok] block bundle://../../../etc/passwd
[ok] block bundle://template/version/../../../etc/passwd
[ok] block bundle://template/version/x/../../../../../etc/passwd
[ok] block bundle://nope/0.0.1/model/weights.onnx (not staged)
[ok] block bundle://(short, no env)
[ok] block http://example.com/foo (wrong scheme)
```

**Status (2026-04-26): tests landed at
`tests/inference/unit_tests/core/registries/test_flytbase_bundle.py`
(11 cases — 8 from above + 3 covering decorator delegation +
empty-URI rejection). All pass.**

## Sibling PR — `inference_models` weights provider

The legacy `RoboflowInferenceModel` path covered here is one of two
model-loading routes. The newer `inference_models.AutoModel.from_pretrained`
path consumes a `ModelMetadata` from a registered provider via
`register_model_provider("name", handler)`.

The matching contribution lives at:

- **`inference_models/inference_models/weights_providers/flytbase_bundle_provider.py`**

It returns a `ModelMetadata` for a Studio bundle staged at
`$FLYTBASE_BUNDLE_CACHE_DIR/<template>/<version>/`, with a `file://`
URL on the local weights, opset/quantization read from manifest, and
license + provenance surfaced via `model_features` so the AutoModel
boundary can enforce D10 license-class gating.

Activation is symmetric:

```python
from inference_models import register_model_provider
from inference_models.weights_providers.flytbase_bundle_provider import (
    get_flytbase_bundle_model,
)

register_model_provider("flytbase_bundle", get_flytbase_bundle_model)
```

Then either the legacy registry route OR the new AutoModel route can
load Studio bundles. Production probably consolidates onto the new one
as upstream migrates more workflow steps off `inference.core.managers.ModelManager`.

Smoke tests on the provider (no engine restart needed):
- 8/8 model-id parsing cases pass (legit + 5 negative)
- ModelMetadata correctly inferred from manifest
  (`distillation_target: rf-detr-base` → `model_architecture: rfdetr`,
  `task_type: object-detection`)
- `trusted_source` set when bundle is `ed25519-prototype`-signed
- `model_features` carries `license.runtime_compatibility`,
  `license.auto_labeler`, weights sha256, classes, input_resolution,
  signer scheme — everything the next layer needs for D10

## What this PR (and the sibling) do NOT do (gated on Phase 3 wiring)

**Status (2026-04-26): the LocalONNXModel gap closed via a
cache-staging adapter — `inference/core/registries/flytbase_bundle_adapter.py`.
`bundle://` URIs now resolve to a synthetic Roboflow-shaped endpoint
(`flytbase-<template>/<version>`), the bundle's weights are
symlinked into `MODEL_CACHE_DIR`, manifest-derived `environment.json`
+ `class_names.txt` + `model_type.json` are synthesised, and a
redirect subclass swaps the `model_id` at instantiation. The
existing `RFDETRObjectDetection` / `RFDETRInstanceSegmentation`
cache-first loader picks up the staged files without an API call.
12 adapter tests + 11 registry tests passing.**

Still gated:

- License-class enforcement at load time (provider surfaces it; AutoModel
  refusal is a separate hook in `inference_models.access_managers`)
- Bundle signature verification at load time (re-runs Studio's
  `verify_bundle.py` Ed25519 check against the staged manifest)
- TRT engine packages per target (D20)
- BYOM bundles where `provenance.distillation_target` is `(none)` —
  caller must supply `model_type=` + `task_type=` overrides via
  `from_pretrained`'s kwargs

These are the natural follow-ups once both halves of this PR pair are
merged + the engine is restarted with both providers registered.

## Phase A scope explicitly NOT covered (production hardening)

These belong to the Phase 3 design but aren't in this PR's diff:

- **License-class gating per D10**: refuse to load `restricted` bundles
  on devices not allow-listed for the auto-labeler's license. The
  resolver returns `Path` and the manifest carries
  `license.runtime_compatibility ∈ {open, restricted, unknown}`;
  enforcement lives at `ModelManager.add_model`.
- **Signature verification at load**: re-run Studio's
  `verify_bundle.py` Ed25519 check against the staged manifest before
  handing back the model class. Studio writes
  `signer.{scheme: ed25519-prototype, key_id, signature}`; the
  trusted-keys table is operator-configured.
- **Cache eviction**: LRU on a per-(template, version) basis. Today
  the cache is append-only; Phase 4 adds eviction.
- **Workflow-context binding**: short-form URIs use an env var, which
  is fine for single-tenant workers but not multi-tenant. Production
  swaps to a `contextvars.ContextVar` set per workflow execution.

## Smoke checklist for reviewers

1. `pytest tests/inference/unit_tests/core/registries/test_flytbase_bundle.py`
   (after the test file lands)
2. Verify non-bundle workflows still validate + run: `POST /workflows/validate`
   on a `yolov8n-640`-based workflow returns `{"status":"ok"}`
3. Stage a Studio bundle, set `FLYTBASE_BUNDLE_REGISTRY_ENABLED=1`,
   restart the engine. `POST /workflows/validate` on the bundle's
   workflow.json continues to return `{"status":"ok"}`.

## Sign-off needed

- Edge runtime owner — registry-decorator pattern is reasonable; PR is
  reversible.
- D6 sign-off (Meta SAM License gating) is **not** required for this PR
  — it's pure URI resolution; license gating is the follow-up's
  responsibility.

## Risks

- Negligible if `FLYTBASE_BUNDLE_REGISTRY_ENABLED=0` (the default
  during rollout).
- After enabling: any model_id that *coincidentally* starts with
  `bundle://` would be intercepted. No existing model_id format does
  (Roboflow IDs are `workspace/project/N`).
