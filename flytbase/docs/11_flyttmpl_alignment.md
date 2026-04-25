# 11 — `.flyttmpl` builder ↔ Studio alignment

**Status**: builder side aligned 2026-04-25 on branch `phase-1-spike`.
Sync 2026-04-26: Studio shipped Phase-3 scaffolds that close a
different gap than the asks below — see "Studio-side updates"
section. Asks 1, 3, 4, 5 still open; Ask 2 stays walked back.

## Problem

Two services were producing files called `.flyttmpl` with **different
internal formats**:

| | Flow builder (was) | Studio Phase A |
|---|---|---|
| Container | zip | tar.gz |
| Manifest format | `manifest.json` | `manifest.yaml` |
| `schema_version` | `flyttmpl/v0` | `0.1` |
| Layout | flat | top-level dir inside |
| Manifest field shape | builder-specific | Studio-specific |

A bundle from one service couldn't be opened by the other. Edge's
`run_workflow.py` (built by Studio) couldn't load builder bundles.

## What changed (builder side)

Builder now emits **Studio Phase A's exact format**:

- Container: `.flyttmpl.tar.gz` with top-level dir
- Manifest: `manifest.yaml` with Studio's field shape
- `schema_version: '0.1'`
- Bundle flavor distinguished by `provenance.source_path: flow_builder`
  (new value alongside Studio's `train_new` / `byom` / `partner_full`)

See [10_flyttmpl_v0_schema.md](10_flyttmpl_v0_schema.md) for the full
manifest layout the builder writes today.

## Studio-side asks

Four concrete changes Studio Phase A needs to pick up before the two
services can fully interop. All small.

### Ask 1 — Add `flow_builder` to `provenance.source_path` enum

Today's Studio code paths emit `train_new` (Path A) or `byom` (Path B);
`partner_full` is reserved for Path C. The flow builder is a **fourth
producer** with its own provenance flavor: a workflow authored locally
on an edge device, no training, no model weights bundled.

Add `flow_builder` as a recognised value. Studio's bundle ingestion
(when reading a slim bundle to enrich) should read this and:

1. Skip Studio's normal "train + label + export" pipeline entirely.
2. Treat the existing `postprocess/workflow.json` as canonical.
3. Walk it for `model_id` references and resolve weights to add to
   `model/`.

Files to update (best guess from Phase A status report):
- `prototype/studio_cli.py` — wherever `provenance.source_path` is set
  (the BYOM path explicitly sets it; presumably Path A does too).
- The license-attestation table that maps `source_path` → defaults can
  remain as-is; `flow_builder` falls through to "let downstream
  resolve per model_id".

### Ask 2 — ~~`run_workflow.py` should resolve bare `model_id` strings~~ (WALKED BACK 2026-04-25)

**Original ask** (kept for record, no longer recommended):

> Make `run_workflow.py` resolve bare `model_id` strings against the
> engine's model registry, so the same executor handles both
> Studio-enriched and builder-slim bundles.

**Why we walked it back**

Looking at the runtime story honestly, the two bundle flavors target
two different execution paths and SHOULDN'T share an executor:

| Flavor | Natural runtime | Why |
|---|---|---|
| Builder slim | inference engine (`/infer/workflows` or local Python entrypoint) | model_ids resolve via `$MODEL_CACHE_DIR`; engine fetches/caches as needed |
| Studio enriched | `run_workflow.py` | weights live inside the bundle; airgap-friendly (no registry calls) |

Forcing `run_workflow.py` to also handle bare model_ids would make it
depend on the engine's model cache, defeating the whole reason it
exists as a separate executor (airgap operation, no registry calls).
Two clean execution paths is the right architecture.

**What this means for builder users**

When you Run a workflow on the builder's RunPanel, the engine resolves
model_ids and runs the workflow. That's the live path; it works today.
When you download a `.flyttmpl` slim bundle and want to deploy it to a
production edge device, Studio's enrichment step (Ask 3 below) walks
the model_ids, downloads the weights into `model/`, rewrites refs to
`bundle://`, and the resulting full bundle runs on `run_workflow.py`.

Two flavors, two runtimes, one enrichment bridge. Clean.

**Reverse direction works today**

Studio full bundles (e.g. Studio's own
`ppe_detector_phase_a_v0.1.0.flyttmpl.tar.gz`) import into the builder
without changes — verified 2026-04-25. Provenance carries through
(`source_path: train_new`, `auto_labeler`, `distillation_target`,
`prompt`, `studio_phase`); fixtures from `fixtures/test_inputs/` land
in the builder's fixture library; step types and `$bundle.model_id`
refs survive. The builder-side import code just walks
`fixtures/test_inputs/` and `postprocess/workflow.json`, ignoring the
Studio-only sections (`model/`, `widget/`, `alerts/`, `card/`).

### Ask 3 — Define the slim → full enrichment step

When a builder bundle arrives (`provenance.source_path: flow_builder`,
no `model/` dir), Studio should be able to enrich it into a deployable
full bundle. Steps:

1. Read manifest, detect slim variant via `source_path`.
2. Walk `postprocess/workflow.json` for `model_id` strings.
3. For each, fetch weights from Model Hub (or local cache) → write to
   `model/<model_id>.onnx`.
4. Rewrite the workflow's `model_id` references from literals to
   `bundle://model/<model_id>.onnx` (or `$bundle.model_id` if the
   workflow has exactly one model).
5. Add Studio's defaults: `widget/dashboard.json`, `alerts/rules.yaml`,
   `card/performance.md` (template; populated after eval run).
6. If builder-shipped fixtures are present in `fixtures/test_inputs/`,
   run them through the enriched bundle to capture
   `fixtures/expected_outputs/`.
7. Update manifest:
   - Add `model`, `hardware`, `license` sections (resolved per model_id).
   - Promote `provenance.source_path: flow_builder` →
     `flow_builder_enriched` (or stay as `flow_builder` with an
     additional `enriched_from: <fingerprint>` field — your call).
   - Recompute `files[]` SHA inventory.
8. Re-sign (when D4 unblocks; today: write `unsigned-prototype` again).

This is the bridge that lets operators author on-edge → push to Studio
→ Studio adds models + widgets + eval → publish to Hub.

New file (suggested): `prototype/enrich_builder_bundle.py`. Could
piggy-back on `studio_cli.py` as a new subcommand
(`studio_cli.py enrich <slim.flyttmpl.tar.gz>`).

### Ask 4 — Extend `hardware.supported_targets` enum

Phase A's open Q6 asked: *"`[x86_cuda, jetson_orin]` — string enum.
Add `jetson_xavier`? `arm64_cpu_only`?"*

Yes to both. Drone-fleet operators run a mix of edge devices:
- `x86_cuda` — dev boxes, in-vehicle compute (current)
- `jetson_orin` — current FlytBase edge device target (current)
- `jetson_xavier` — older deployments still in field; supported until EOL
- `arm64_cpu_only` — fallback for sites without GPU (uses ONNX CPU EP)

Document the enum in your manifest writer. The flow builder skips this
field on slim bundles, so this is purely Studio-side.

## Why "Studio wins" on format

Two producers, one had to adapt. Studio is:

- Customer-facing (Path A/B/C produces bundles for paying customers
  starting at Phase B).
- Higher volume (one Studio service emits many bundles for many edge
  devices).
- Already shipped (Phase A Week-1 done; bundles produced and verified).

The flow builder is:

- Local airgap authoring tool (lower volume).
- Single edge-device target (one builder per edge).
- Newer (just shipped its first bundle format).

Whichever side has more bundles already in the wild wins on
backwards-compat. That's Studio.

## Verifying interop (smoke run 2026-04-25)

Built + ran Studio's `verify_bundle.py` against a builder bundle:

```
[ ok ] bundle exists: /tmp/bundle.tar.gz
       size: 0.1 MB
[ ok ] tar extract OK (8 members)
[ ok ] bundle root: Align_Test_v0.1.0.flyttmpl
KeyError: 'classes'   # at: print(f"... classes={manifest['template']['classes']})")
```

What the builder gets right:
- Tarball with top-level DIRTYPE entry ✓
- `manifest.yaml` parseable as YAML ✓
- Manifest's required top-level keys present (`schema_version`, `template`,
  `provenance`, `signer`, `files`) ✓
- `files[]` SHA inventory matches actual file contents (verified locally) ✓

Where Studio's verifier needs updating (Ask 5 below — wasn't on the
original list):

### Ask 5 — `verify_bundle.py` should handle slim bundles

Today the verifier assumes every bundle has:
- `template.classes` (list of class names)
- `model.path`, `model.sha256`
- `model/weights.onnx` runnable through onnxruntime

Builder bundles have none of those. The verifier should:

1. Read `provenance.source_path` first.
2. If `flow_builder`: skip the model-weight checks; verify only the
   files that exist (`postprocess/workflow.json`, fixtures, README,
   `files[]` SHAs).
3. Else: full-bundle verification (today's behavior).

Or alternatively: walk `files[]` and verify SHA on every entry, then
condition further checks on what's actually present in the tarball.

`template.classes` should also be **optional** — builder workflows
don't have a flat class list (workflows can run multiple models, each
with its own classes; "the workflow's classes" isn't well-defined).
Suggest making it optional in the schema and printing `(none)` when
absent.

Files to update:
- `prototype/verify_bundle.py` — line ~78 onward.

## Studio-side updates (sync 2026-04-26)

Pulling notes from `air_studio/phase_A_status.md` Findings 14–18 and
the matching files now sitting in this repo.

### Step-type tags reconciled

Studio's `phase_A_status.md` Finding 17 reports they smoke-tested a
full Studio bundle against our live `:9001` engine and fixed two
contract bugs **on their side**:

- Step type `roboflow_core/object_detection_model@v2` →
  `roboflow_core/roboflow_object_detection_model@v1`
  (canonical engine name).
- Step input field `image:` → `images:` (plural) for detector blocks.

Studio's `run_workflow.py` `STEP_REGISTRY` (lines 464–469) now
accepts the canonical names plus the legacy aliases. Critical detail:
**`roboflow_core/roboflow_object_detection_model@v2` is NOT in the
registry** — only `@v1` is. Both versions are registered in our
engine's block registry with identical schemas, but Studio's airgap
runner only handles `@v1`.

**Builder-side fix (this commit, 2026-04-26)**: 5 of our 6 seed
templates were emitting `@v2`. Flipped them to `@v1` so a slim bundle
that gets enriched by Studio runs end-to-end on `run_workflow.py`.
All 5 re-validate `{"status":"ok"}` through `/workflows/validate`.
Files touched:

- `templates/01_detect_objects.json`
- `templates/02_count_per_frame.json`
- `templates/04_track_people.json`
- `templates/05_line_crossing_counter.json`
- `templates/06_zone_dwell_time.json`

`03_segment_with_text.json` uses `sam3@v1` (foundation labeler), not
a trained-detector block, so unchanged. Note: Studio's
`run_workflow.py` doesn't handle `sam3@v1` either — segmentation step
support is `instance_segmentation_model@v1` for trained RFDETRSeg
weights only. SAM3 as a runtime block is an open Studio-side gap if
slim-bundle enrichment ever needs to preserve it.

### `bundle://` URI resolver — scaffolds shipped, wiring still ours

Studio's Finding 18 closes the spec-side half of the `bundle://`
URI gap. Two files landed in this repo:

- `inference/core/registries/flytbase_bundle.py` —
  `FlytBaseBundleRegistry` decorator over any `ModelRegistry`.
  Resolves long form `bundle://<template>/<version>/<file>` against
  `$FLYTBASE_BUNDLE_CACHE_DIR` and short form `bundle://<file>`
  against `$FLYTBASE_ACTIVE_BUNDLE_ROOT`. Path-traversal defence
  in place.
- `inference_models/.../weights_providers/flytbase_bundle_provider.py` —
  companion for the newer `AutoModel.from_pretrained` route.

PR draft: [`flytbase/pr_drafts/flytbase_bundle_registry.md`](../pr_drafts/flytbase_bundle_registry.md).

**Done (2026-04-26)**:

- ✅ **Wiring**: `docker/config/gpu_http.py` now wraps
  `RoboflowModelRegistry` with `FlytBaseBundleRegistry` when
  `FLYTBASE_BUNDLE_REGISTRY_ENABLED=1` (default off — dormant
  without explicit opt-in). Engine restart required to take effect.
- ✅ **Tests**: `tests/inference/unit_tests/core/registries/test_flytbase_bundle.py`
  with 11 cases (8 from PR draft — long/short URI happy paths, 3
  traversal blocks, unstaged-file block, no-env-root block, wrong
  scheme, empty URI — plus 3 covering decorator delegation +
  bundle-id interception). `pytest` clean inside `flytbase-infer-v122`.

**Done (2026-04-26 follow-up)**:

- ✅ **Local-bundle adapter** (`inference/core/registries/flytbase_bundle_adapter.py`):
  `bundle://` → bundle root → manifest read → stage `weights.onnx`
  symlink + synthesised `environment.json` + `class_names.txt` +
  `model_type.json` under `MODEL_CACHE_DIR/flytbase-<template>/<version>/`.
  `FlytBaseBundleRegistry.get_model` then delegates to the wrapped
  Roboflow registry with the synthetic endpoint, and a redirect
  subclass swaps the `model_id` at instantiation time so the regular
  `RFDETRObjectDetection` / `RFDETRInstanceSegmentation` cache-first
  loader picks up the staged files without an API call. 12 adapter
  tests + 11 registry tests passing inside `flytbase-infer-v122-bundle`.

**Still on the builder/edge side**:

- **License-class gating per D10**: provider surfaces
  `runtime_compatibility` in `model_features` but enforcement is a
  follow-up hook in `inference_models.access_managers`.
- **Signature verification at load**: re-runs Studio's
  `verify_bundle.py` Ed25519 check; deferred.
- **`inference_models` provider registration**: the symmetric
  `register_model_provider("flytbase_bundle", ...)` for the newer
  `AutoModel.from_pretrained` route isn't in any startup hook yet.
  Lower priority — the legacy registry route now works end-to-end
  via the staging adapter.
- **End-to-end smoke against a real Studio bundle**: container
  restart + a staged `.flyttmpl` + a workflow referencing
  `bundle://...` model_id. Mechanically straightforward; tracked
  separately because it needs a fresh container boot.

### What this means for the two-runtime story

The alignment doc earlier laid out two execution paths:
- Builder bundles → inference engine via `/infer/workflows`.
- Studio enriched bundles → `run_workflow.py`.

Studio's Phase-3 contributions add a *third* pathway: **Studio full
bundle pre-staged on the engine, executed via the production
workflow engine with `bundle://` URI resolution**. That's the
airgap-friendly path for production edge devices that don't run
`run_workflow.py`. It's the cleanest long-term home for Studio
bundles in production — but it's blocked on the wiring + adapter
work above, which lands in Edge Phase 3.

### Status of the original asks

| Ask | Status |
|---|---|
| 1 — `flow_builder` in `provenance.source_path` enum | open; Studio's import accepts it (Finding 17 row "provenance.*"), but their writer doesn't emit it. Not yet a blocker. |
| 2 — `run_workflow.py` resolves bare `model_id` | walked back 2026-04-25; superseded by the registry-decorator pathway above |
| 3 — slim → full enrichment step | open; Finding 17 confirms Studio designs an "enricher" role, file not built |
| 4 — `hardware.supported_targets` enum extensions | open; not surfaced in Findings 14-18 |
| 5 — `verify_bundle.py` handles slim bundles | open; not surfaced in Findings 14-18 |

## Owner

- Builder side (this repo): @harshduchefb (current)
- Studio side (`/home/rtx5090/air_studio/prototype/`): same author per
  Phase A status report owner field

Asks 1, 3, 4, 5 above are tracked here; tick them off in this doc as
they land. Edge-side activation of `FlytBaseBundleRegistry` +
`LocalONNXModel` adapter is Edge Phase 3 work item 2.
