# 10 — `.flyttmpl` schema (flow-builder slim variant)

**Status**: aligned with AI-R Studio Phase A on 2026-04-25 (see
[11_flyttmpl_alignment.md](11_flyttmpl_alignment.md)). The flow builder
emits the **same manifest shape** Studio Phase A emits — just with
fewer fields populated. Both producers' bundles are valid input to the
same Edge-side loader.

This is **schema_version 0.1**. D3 is still "NOT YET MADE" — the schema
will iterate, but both producers will iterate together.

## What the builder emits today

The builder's slim variant ships a full Studio-shape manifest with the
following fields populated:

- `template` — name, version (`0.<bundle_version>.0`), kind=`workflow`,
  description, created_at, workflow_id
- `provenance` — source_path=`flow_builder`, studio_phase=`builder-edge`,
  workflow_fingerprint, bundle_version, model_ids, fixtures_count
- `signer` — scheme=`unsigned-prototype`, key_id=null, signature=null
- `files` — sha256 + size_bytes for every non-manifest file in the bundle

Sections **omitted** (Studio's enricher fills them at handoff):

- `model` — builder ships no weights
- `hardware` — workflows are device-agnostic until deployed
- `license` — Studio resolves per-`model_id` licenses at enrichment

## Layout

```
<template_name>_v<version>.flyttmpl.tar.gz   # gzipped tar
└── <template_name>_v<version>.flyttmpl/
    ├── manifest.yaml                         # Studio Phase A shape
    ├── postprocess/
    │   └── workflow.json                     # Roboflow Workflow JSON, sorted keys
    ├── fixtures/
    │   └── test_inputs/                      # only present if user saved fixtures
    │       └── *.jpg / *.png / *.mp4
    └── README.md                             # human-readable summary
```

Studio's full bundles add `model/`, `widget/`, `alerts/`, `card/`, and
`fixtures/expected_outputs/`. A single Studio-shape Edge loader handles
both flavors — flow-builder bundles just look like Studio bundles with
several sections empty.

## Manifest example

```yaml
schema_version: '0.1'
template:
  name: "Detect People at Drone Dock"
  version: 0.3.0
  kind: workflow
  description: "Counts people on the landing pad before takeoff."
  created_at: '2026-04-25T15:42:01+00:00'
  workflow_id: detect-people-dock
provenance:
  source_path: flow_builder         # NEW value, alongside Studio's train_new / byom / partner_full
  studio_phase: builder-edge
  workflow_fingerprint: 32af08f0bb9f2c1c436f59f98a4284dd...
  bundle_version: 3
  model_ids:
    - yolov8n-640
  fixtures_count: 2
signer:
  scheme: unsigned-prototype
  key_id: null
  signature: null
  note: "Builder-edge bundle — re-signed by Studio enricher or Bundle Signing Service before deployment"
files:
  - path: README.md
    sha256: ...
    size_bytes: 692
  - path: fixtures/test_inputs/drone_view_1.jpg
    sha256: ...
    size_bytes: 92563
  - path: fixtures/test_inputs/dock_empty.jpg
    sha256: ...
    size_bytes: 81203
  - path: postprocess/workflow.json
    sha256: ...
    size_bytes: 487
```

## URI conventions in `postprocess/workflow.json`

The flow builder's `workflow.json` uses **literal `model_id` strings**:

```json
{ "model_id": "yolov8n-640" }
```

Studio Phase A bundles use **`bundle://` URIs** that point at the
bundle's own `model/` dir, with the engine resolving them at load time:

```json
{ "model_id": "$bundle.model_id" }   // Studio's convention; resolves to model/weights.onnx
```

Both are valid. Studio's `run_workflow.py` needs a fall-through that
resolves bare `model_id` strings against the engine's model registry —
[see ask #2 in 11_flyttmpl_alignment.md](11_flyttmpl_alignment.md).

When Studio enriches a builder bundle, it walks the spec, downloads
each `model_id`'s weights into `model/`, and rewrites the references to
`$bundle.model_id`.

## Endpoint

```
GET /flybuild/api/{workflow_id}/bundle?version=N
```

- Returns: `application/gzip`
- Filename: `<template_name>_v0.<bundle_version>.0.flyttmpl.tar.gz` via
  `Content-Disposition`
- CSRF: required (`X-CSRF` header)
- `version` defaults to `current_version` from `<sha>/meta.json`
- Bundle bytes are assembled on demand, no on-disk cache

## Stability guarantees

- `schema_version` advances only when Studio + builder advance together.
- `provenance.source_path` is the bundle-flavor discriminator. Reading
  code MUST gate enrichment / loading logic on this field.
- `provenance.workflow_fingerprint` is sha256 of the canonical-JSON
  workflow spec. Stable across machines, OS, Python versions —
  downstream caches use it for dedupe.
- `signer.scheme` field name stays stable through D4 sign-off (per
  Studio's Q4); only the `scheme` value, `key_id`, `signature` change.

## Field-by-field

| Field | Builder slim | Studio full | Notes |
|---|---|---|---|
| `schema_version` | `'0.1'` | `'0.1'` | Same |
| `template.name` | workflow display name | template display name | Same field |
| `template.version` | `0.<bundle_v>.0` | curator-set semver | Studio enricher may rewrite |
| `template.kind` | `workflow` | `detection`/`segmentation`/`keypoint` | Studio enricher reclassifies |
| `template.workflow_id` | builder's id | (absent) | Builder-only field |
| `model` | (absent) | populated | Studio fills |
| `hardware` | (absent) | populated | Studio fills |
| `license` | (absent) | populated | Studio fills |
| `provenance.source_path` | `flow_builder` | `train_new` / `byom` / `partner_full` | New enum value |
| `provenance.workflow_fingerprint` | populated | (Studio doesn't use today) | Useful for dedupe; suggest Studio adopt |
| `provenance.fixtures_count` | populated | implicit (count of files in fixtures/) | Builder-only convenience field |
| `signer` | `unsigned-prototype` | `unsigned-prototype` | Same field name |
| `files` | every non-manifest file | every non-manifest file | Same shape |

## Sign-off needed (when D3 unblocks)

- Architect: confirms manifest fields cover what downstream services
  need.
- Studio team: confirms enrichment story (slim → full) per [11](11_flyttmpl_alignment.md).
- Edge team: confirms loader handles both flavors via a single code path.
- PM: confirms `0.1 → 0.2 → 0.3 …` migration plan when D3 locks.
