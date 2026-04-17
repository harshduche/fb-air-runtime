# 03 — Current Status

**As of 2026-04-17.** Phase 1 is complete; no other phase has started.

## Phase 1 — Feasibility spike

**Status**: deliverable committed on branch `phase-1-spike`. Awaiting
PM/architect review before Phase 2 can begin.

**Commits on the branch** (local only — no remote fork exists yet):
- `3e5c71e9c [phase-1] Add Phase 1 feasibility spike report`
- `87bbd32b0 [phase-1] Amend spike report with SAM 3 sources + pipeline retry`

**Primary deliverable**: [`../phase_1_feasibility_spike.md`](../phase_1_feasibility_spike.md).

**Top-line verdict**: **viable to proceed to Phase 2**, with two findings
that slightly expand the Phase 2/3 scope.

## What was verified

### Static (code inspection at tag `v1.2.2`)

- Upstream `register_model_provider()` is a genuine public API with a
  worked `local_file_provider` example in its docstring
  (`inference_models/inference_models/weights_providers/core.py`).
- `ModelMetadata` is fully provider-agnostic and already models
  Jetson/TRT environment requirements.
- Exactly one cross-import from `inference/core/` into
  `inference/enterprise/`, at
  `inference/core/workflows/execution_engine/introspection/blocks_loader.py:45`.
  Phase 2 will guard this with the existing `LOAD_ENTERPRISE_BLOCKS` env.
- SAM 3 lives in the older `inference/models/` tree, not the newer
  pluggable `inference_models/` tree. Its weight loader goes through the
  legacy Roboflow registry (`inference/core/models/roboflow.py:648`).
- Cloud-push workflow blocks enumerated and confirmed safe to delete
  (none are on the default execution path).

### Hardware (x86 + NVIDIA RTX 2000 Ada, Ubuntu 22.04, Docker 27.3.1)

- Server boots without a Roboflow API key and without a `~/.roboflow`
  config.
- Image under test: `roboflow/roboflow-inference-server-gpu:latest` (pushed
  2026-04-10); server `/info` reports `version: 1.2.2`. The Docker image
  matches the tag we inspected statically.
- **YOLOv8n-640 single-image** (cold): 5.7 s total including model fetch.
- **YOLOv8n-640 single-image** (warm): 8–18 ms per call, **55–125 FPS**
  steady state. Well above the 10-FPS target for single-stream processing.
- **Local inline workflow** (detect + bounding-box viz + webhook sink):
  53 ms warm, HTTP 200, webhook sink fired asynchronously. Full workflow
  engine round-trip, no Roboflow cloud fetch of the spec.
- **Video pipeline**: initializes cleanly, produces initial frames with
  3.7–18.5 ms inter-arrival gaps (> 200 FPS instantaneous). Sustained HTTP
  consume blocks on an **upstream IPC defect** in v1.2.2
  (`stream_manager_client.py:245`) — not a fork-decision blocker because
  our runtime will drive the engine in-process.
- **Network audit** (440-second tcpdump under default config, no API key):
  - `api.roboflow.com` — 84 DNS queries, 28 TLS SNIs. Telemetry heartbeat
    every 60 s + model metadata + SAM 3 auth attempt.
  - `repo.roboflow.com` — 48 DNS, 16 TLS. Model weights registry.
  - `http-intake.logs.us5.datadoghq.com` — 3 DNS, 2 TLS. **Datadog log
    forwarding. Not in the static audit; new finding.**
  - `api.github.com` — 6 DNS, 2 TLS. Pingback.
  - Zero hits to `*.ultralytics.com`, `huggingface.co`, or OTEL external
    collectors.

### What failed / was not verified

- **SAM 3 concept_segment returns HTTP 401** even with `usage_billable:
  false` and `disable_model_monitoring: true`. Code path:
  `inference/models/sam3/segment_anything3.py:458` →
  `inference/core/models/roboflow.py:646` →
  `inference/core/roboflow_api.py:124` → 401. **Does not match the
  README's "Foundation Models ✅ Open Access" implication.**
- **Jetson Orin run**: no Jetson available on this host. Remains
  outstanding for a human to execute on real hardware.
- **Sustained pipeline FPS**: not measured, see upstream IPC defect above.

## Two findings that shift Phase 2/3 scope

### Finding A — Datadog telemetry exporter

The runtime forwards logs to `http-intake.logs.us5.datadoghq.com` by
default, independent of the `api.roboflow.com` usage-tracking path. The
static audit missed this; only the tcpdump audit caught it.

**Phase 2 implication**: on top of the `UsageCollector` kill switch
originally planned, Phase 2 must also locate and disable the Datadog
client. Added as work item 5 in [02_plan_and_phases.md](02_plan_and_phases.md).

### Finding B — SAM 3 airgap is cheaper than first estimated

Initial assumption: SAM 3 airgap needs either a provider shim on the
legacy registry (option B in the spike), or a rewrite of the model
loading path (option C). Reality is cheaper:

- Meta publishes SAM 3 weights on HuggingFace as `facebook/sam3` and
  `facebook/sam3.1` (gated, request approval).
- License (Meta SAM License, Nov 2025) permits commercial use with
  military/ITAR/sanctioned-entity carve-outs.
- The code already has two escape hatches:
  - `segment_anything3.py:398` has `load_from_HF=False` — flipping to
    `True` loads from HuggingFace without touching Roboflow's registry.
  - `segment_anything3.py:447` and `roboflow.py:663` both early-return
    on cache hit, so pre-staging weights bypasses the auth check.

**Phase 3 implication**: combine (a) pre-staging Meta-sourced weights in
the template bundle with (b) cache-first short-circuit. Both small,
reinforcing changes. Full detail in
[05_key_design_decisions.md](05_key_design_decisions.md).

## Artifacts from the spike

These live on the dev host, not in the repo. Retained for audit; delete
at operator discretion. None are required for Phase 2.

- `/home/deair/inference-spike/probes/` — HTTP probe scripts, four
  iterations. Logs in `logs/`.
- `/home/deair/inference-spike/probes/video_pipeline_v{1,2,3,4}.py` — four
  attempts at the pipeline probe; v4 is the final one that uses direct
  HTTP with timeouts.
- `/tmp/phase1_capture.pcap` — 58 MB pcap, 440 s of network traffic
  during the probe run. Readable with tshark/wireshark.
- `/tmp/cache/phase1_video.mp4` (14 s) and `phase1_video_long.mp4` (180 s)
  — test videos.
- `/home/deair/inference-spike/server_start*.log` — server startup logs.
- `/home/deair/inference-spike/venv/` — Python venv used by the probes.

## Gating

Do not start Phase 2 until:

1. PM/architect acknowledges the two findings in (A) and (B) above.
2. PM/architect acknowledges the "public workflows are not airgap"
   correction in §4 of the spike report.
3. Jetson Orin hardware verification is either completed or explicitly
   deferred to Phase 2 with rationale.

See [02_plan_and_phases.md](02_plan_and_phases.md) for Phase 2 work items.
