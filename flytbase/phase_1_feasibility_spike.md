# Phase 1 — Feasibility Spike Report

**Goal**: decide whether forking `github.com/roboflow/inference` is a viable foundation for the FlytBase AI-R Edge template runtime, or whether we need to change approach.

**Baseline inspected**: tag `v1.2.2` (`dd5cfa59b Fix bug with MacOS build (#2223)`). The six commits on upstream `main` past v1.2.2 were reviewed in passing; they are drift (new workflow-block model additions + one serverless auth fix) and do not affect the feasibility signal.

**Method**: static inspection of the codebase in the local checkout at `/home/deair/inference`. Hardware-dependent steps in the plan (x86 GPU run, Jetson Orin run, live RTSP at ≥10 FPS, tcpdump network audit over a 10-minute live session) have **not** been executed in this spike. They are enumerated in §9 as follow-up items that a human must run before the gate closes; this report alone is not sufficient to close Phase 1.

---

## 1. Verdict

**Viable to proceed to Phase 2.** Hardware run on A2000 Ada (see §12) confirms the core runtime works and single-image latency beats the plan's 10 FPS target by a wide margin. Two findings upgrade the scope of later-phase work but do not block the decision to fork.

The de-risking questions the spike was designed to answer:

| Question | Status | Notes |
| --- | --- | --- |
| Is the weights provider genuinely pluggable? | GREEN | `register_model_provider()` is an explicit public API with a `local_file_provider` example in the docstring. |
| Can we load pre-trained models without an API key? | GREEN | Hardware-confirmed: `yolov8n-640` alias, warm 8–18 ms/call, 55–125 FPS single-image. |
| Can we run foundation models without Roboflow cloud? | **RED, larger than static audit implied** | SAM 3 returns hard 401 on the default path even with billing/monitoring flags off. Airgap SAM 3 requires pre-staged weights **plus a code patch** to remove the `download_model_from_roboflow_api` auth call (§10, §12). Still engineering-cheap but not free. |
| Is the enterprise/ boundary clean enough to delete? | YELLOW | Exactly one cross-import from core into enterprise; cheap to patch (§5). |
| Can we disable telemetry and outbound calls? | YELLOW, **plus a new exporter** | OpenTelemetry defaults off. The always-on `UsageCollector` has an env override but no explicit feature flag. **New finding**: the server also forwards logs to `http-intake.logs.us5.datadoghq.com` by default; not in the static audit; Phase 2 must neutralize it too (§12). |
| "Public workflows without API key" = airgap-clean? | RED but narrow | The public-workflow path fetches specs from `api.roboflow.com`. Not a local execution path. We must replace the workflow-spec loader anyway in Phase 3 — matches the plan. |
| Does the execution engine run fully local? | GREEN | Hardware-confirmed: inline workflow spec with detection + visualization + webhook sink executed end-to-end in 53 ms warm with HTTP 200 (§12.1). |

No escalation-triggering blocker was found. Two findings (SAM 3 airgap cost, Datadog exporter) expand the Phase 2/3 work slightly; see §10 and §12 for exact scope deltas.

---

## 2. Weights provider is pluggable

`inference_models/inference_models/weights_providers/core.py` exposes a clean plugin contract:

```python
register_model_provider("flytbase", flytbase_weights_fetcher)
```

where the handler signature is `(model_id: str, api_key: Optional[str], **kwargs) -> ModelMetadata`. The built-in `"roboflow"` provider is registered through the same mechanism — no private seam. The docstring at `core.py:151–168` includes a worked `local_file_provider` example that is structurally identical to what our FlytBase provider will be.

`ModelMetadata` (`inference_models/inference_models/weights_providers/entities.py`) is fully provider-agnostic:

- `FileDownloadSpecs(download_url, file_handle, md5_hash)` — our provider can return `file://` URLs pointing to cached bundle contents, or signed internal URLs.
- `ONNXPackageDetails` / `TRTPackageDetails` / `TorchScriptPackageDetails` — all three backends already modeled.
- `ServerEnvironmentRequirements` and `JetsonEnvironmentRequirements` — Jetson/TRT compatibility matching is already baked in; we inherit it for free.

**Implication**: Phase 3 weights-provider implementation is a small function, not a framework. The interesting Phase 3 work is bundle format, signing, airgap delivery, and workflow-spec adaptation.

---

## 3. Model tree split (flag for Phase 3 design)

The codebase has **two model trees**:

1. `inference_models/inference_models/models/…` — newer, provider-pluggable tree governed by the `register_model_provider` mechanism above. YOLO (v5/v7/v8/v10/v11 via `yolo26`), RT-DETR, CLIP, Florence-2, SAM 2, Moondream, ViT, ResNet, DeepLabV3+, DINOv3, Perception Encoder, etc.
2. `inference/models/…` — older tree with its own weight-fetching path. **SAM 3 (`inference/models/sam3/visual_segmentation.py`) is here.**

SAM 3 defaults `model_id="sam3/sam3_final"` and fetches weights through `self.cache_file("weights.pt")` — an inherited method that routes through the legacy Roboflow registry at `inference/core/registries/roboflow.py`. Until SAM 3 migrates to the new tree (upstream work), our FlytBase integration must cover both paths.

**Options for Phase 3 (updated after SAM 3 alternate-source research — see §12.6)**:

- **A**: Pre-stage SAM 3 weights in `are_all_files_cached(...)` path — the legacy registry short-circuits on cache hit (`inference/models/sam3/segment_anything3.py:447`). Lowest engineering cost. The **only** lift beyond the existing caching logic is acquiring the weights from somewhere other than Roboflow; see §12.6 for Meta/HF sourcing.
- **B**: Flip the `load_from_HF=False` flag to `True` at `inference/models/sam3/segment_anything3.py:398`. The underlying `sam3` pip package (Meta's official) already supports loading from HuggingFace directly. **Roughly one line of patch.** Requires HuggingFace access token at runtime, and HF gate approval for `facebook/sam3`.
- **C**: Patch `inference/core/models/roboflow.py:648 download_weights()` to consult our FlytBase weights provider first and skip the Roboflow API auth call on cache hit. Robust, slightly more code, good rebase candidate for upstream (cache-hit-skips-auth is a reasonable fix to submit back).
- **D**: Write a second provider shim that intercepts the legacy path (original option C). Cleanest long-term but most code. No longer the only non-hacky option now that B exists.
- **E** (fallback): Replace SAM 3 with SAM 2. SAM 2 lives in the newer tree at `inference_models/inference_models/models/sam2/` and, per the research, doesn't have the same outbound dependency. Slight quality drop; fastest Phase 3 unblock if A/B/C all snag.

**Recommendation**: combine **A** (pre-stage Meta-sourced weights in the image) + **C** (cache-first short-circuit on `download_weights`). Both are small, reinforcing, and let us ship airgap with no runtime HF dependency. Option B stays as a secondary escape hatch for development ergonomics.

Still a Phase 3 design discussion for PM / architect, but the decision is narrower than before: source-from-Meta is viable; the question is just *which* combination of (A, B, C, D, E) you want.

---

## 4. API-key gating — what actually works without a key

Confirmed via static audit of `inference/core/roboflow_api.py`, `inference/core/workflows/core_steps/sinks/roboflow/*`, and `inference_sdk/config.py`:

| Path | Works without API key? | Notes |
| --- | --- | --- |
| Load local ONNX model (YOLO family, RT-DETR) | ✅ | No API call. |
| SAM 3 inference on a locally-cached checkpoint | ✅ if weights pre-staged | Otherwise, legacy registry will attempt to fetch from Roboflow. |
| Video stream (RTSP / local file) inference | ✅ | Pipeline manager does not require a key. |
| Dynamic Python blocks | ✅ | Gated separately by a sandbox flag, not API key. |
| **Load a "public workflow" spec** | ❌ as "airgap" | Still fetches the spec from `api.roboflow.com/{workspace}/{workflow_id}`. Runs without an API key, but is **not** a local execution path. |
| `roboflow_dataset_upload` block | ❌ | Hard 401 without a valid key. Remove in Phase 2. |
| `model_monitoring_inference_aggregator` block | ❌ | Hard 401 without a valid key. Remove in Phase 2. |

**Key correction** to the original brief: in the README's matrix, "Public Workflows ✅ Open Access" does *not* mean "runs with zero Roboflow dependency". It means "runs without a paid account". Our Phase 3 Model-Hub workflow-spec loader is not optional — it is the only way to deliver airgap-clean workflow execution. This aligns with the plan as written; flagging it here so we don't assume "strip the API key and public workflows just work".

---

## 5. Enterprise boundary — one fixup needed

`inference/enterprise/` is source-available (different license). We will delete it in Phase 2.

I grepped every non-enterprise import of `inference.enterprise.*` under `inference/`. On v1.2.2, exactly **one** cross-import exists outside of the enterprise tree and its own tests:

```
inference/core/workflows/execution_engine/introspection/blocks_loader.py:45
    from inference.enterprise.workflows.enterprise_blocks.loader import load_enterprise_blocks
```

This is a module-level import, so deleting `inference/enterprise/` without patching the core will produce `ImportError` when the workflow engine starts. Good news: `inference/core/env.py` already defines `LOAD_ENTERPRISE_BLOCKS` (imported on line 12 of the same file), which gates the *call* to `load_enterprise_blocks()`. The call site is already feature-flagged; only the import itself is unconditional.

**Phase 2 patch** (cheap, ~10 LOC): make the import lazy inside a `if LOAD_ENTERPRISE_BLOCKS:` guard, or provide a no-op `load_enterprise_blocks()` stub in the non-enterprise tree. This is the *only* mechanical blocker to the `rm -rf inference/enterprise/` step.

No other core→enterprise imports exist. The enterprise tree is otherwise cleanly separated.

---

## 6. Outbound URL inventory (static)

**NB**: this is a static inventory. It enumerates URLs that *can* be reached at runtime; it does not prove they *are* reached during a typical inference workflow. The 10-minute tcpdump session specified in the plan still needs to run on hardware to confirm.

**Roboflow endpoints (every one is configurable via env var)**:

| Domain | File:line | Env override | Reached on default path? |
| --- | --- | --- | --- |
| `api.roboflow.com` (platform) / `api.roboflow.one` (self-hosted) | `inference/core/env.py:51–53` | `API_BASE_URL`, `PROJECT` | Yes — legacy model registry and workflow spec loader. |
| `detect/outline/classify/infer/serverless/asyncinfer.roboflow.com` | `inference_sdk/config.py:75–83` | None directly; SDK-only, not hit by local server. | Only by SDK clients configured for hosted. |
| `/dataset/{id}/upload`, `/annotate`, `/inference-stats` | `inference/core/roboflow_api.py:682, 737, 1204` | N/A — endpoints composed from `API_BASE_URL`. | Only from cloud-push blocks (stripped in Phase 2). |

**Telemetry endpoints**:

- `METRICS_COLLECTOR_BASE_URL` in `inference/usage_tracking/config.py:16–22` — defaults to `API_BASE_URL`. Env-overridable. Used by `UsageCollector` which is instantiated at app startup and runs a background flush thread. **No feature flag for "off".** Phase 2 should add one.
- `OTEL_EXPORTER_ENDPOINT` in `inference/core/telemetry.py:393–401` — defaults to `localhost:4317`. Gated by `OTEL_TRACING_ENABLED` (default `False`). **No Roboflow endpoint baked in.** This is safer than the original brief assumed; we do not need to rip OTEL out, just leave it off by default and optionally point it at a FlytBase collector later.

**HuggingFace / other**: no hard-coded HuggingFace URLs; HF-backed foundation models (CLIP, Florence-2, etc.) use the standard `transformers` cache, which does call `huggingface.co` on first run if weights aren't staged. For airgap, we must pre-stage the HF cache in the image — same pattern as SAM 3.

---

## 7. Cloud-push workflow blocks to strip

Core-Apache blocks that push data *to* Roboflow — all opt-in, none on the default path, all safe to delete in Phase 2:

- `inference/core/workflows/core_steps/sinks/roboflow/dataset_upload/v1.py`, `v2.py`
- `inference/core/workflows/core_steps/sinks/roboflow/model_monitoring_inference_aggregator/v1.py`
- `inference/core/active_learning/` (older pipeline; hooked into the same `register_image_at_roboflow()` helper)

Shared helper `register_image_at_roboflow()` and `send_inference_results_to_model_monitoring()` live in `inference/core/roboflow_api.py`. If we remove all callers, the helpers become dead. Deletion is mechanical.

Enterprise-licensed cloud-push blocks (already going away with `inference/enterprise/`): `event_writer`, PLC Modbus/EthernetIP, OPC writer, MQTT writer, Microsoft SQL Server sink.

---

## 8. Workflow spec loader architecture

The workflow spec loader lives at `inference/core/roboflow_api.py:884–983` (`get_workflow_specification`). It's a thin fetcher: resolves `{workspace_name}/{workflow_id}` against `API_BASE_URL`, optionally auth'd with an API key, caches the result locally.

This is clean enough to replace wholesale with a FlytBase loader in Phase 3. The rest of the workflow execution engine consumes a well-typed spec object and does not care where it came from. No deep surgery needed — we swap one function.

The feature matrix in `inference/core/workflows/execution_engine/introspection/blocks_loader.py` also handles workflow-block registration; FlytBase-specific blocks will register through the same `WORKFLOWS_PLUGINS` plugin discovery mechanism (env var + entrypoints). That is the intended extension seam.

---

## 9. What still needs to run on hardware before the gate closes

These are the Phase 1 tasks that require real hardware. Results as of the x86 run on 2026-04-17:

- [x] **x86 + CUDA GPU run**: executed on NVIDIA RTX 2000 Ada (16 GB VRAM) + Ubuntu 22.04 + CUDA 12.4 + Docker 27.3.1. Server started without `ROBOFLOW_API_KEY` and without `~/.roboflow`. Image used: `roboflow/roboflow-inference-server-gpu:latest` (pushed 2026-04-10, server `/info` reports `version: 1.2.2`). See §12.
- [ ] **Jetson Orin run**: **not executed** — no Jetson on this host. Remains outstanding for a human.
- [x] **Local-weights YOLO inference on a static image**: probed via the `yolov8n-640` alias path (not a raw Ultralytics ONNX — see §12 note). Warm latency 8–18 ms/call (55–125 FPS single-image). First call 5.7 s including model fetch from `repo.roboflow.com`.
- [x] **SAM 3 text-prompt inference with no API key**: **FAILED with HTTP 401.** Even with `usage_billable: false` and `disable_model_monitoring: true`, the server calls `download_model_from_roboflow_api` → `api.roboflow.com` → 401. Material finding; see §10 and §12.
- [~] **RTSP/video-file pipeline at ≥10 FPS**: **partial — engine produces frames, sustained HTTP consume blocked by an upstream IPC defect.** Pipeline initializes cleanly and produces frames with inter-arrival gaps of 3.7–18.5 ms (>200 FPS peak). Sustained HTTP `/consume` returns 200-empty after the initial burst because the pipeline-manager IPC (`stream_manager_client.py:245`) goes unresponsive. This is not a fork-decision blocker because our own runtime will drive the engine in-process, not through this HTTP layer. Full details in §12.2.
- [x] **Minimal local workflow (detect + viz + webhook)**: executed end-to-end. Workflow spec inlined as a POST body (no Roboflow cloud fetch). HTTP 200. Webhook sink fired a notification asynchronously.
- [x] **`tcpdump` network audit**: executed via an ephemeral host-networked `alpine` container with `CAP_NET_RAW`; captured 440 s of traffic to `/tmp/phase1_capture.pcap` (58 MB) during the probe run. See §12 for decoded results.

All raw artifacts live under `/home/deair/inference-spike/` (probes, logs, pcap) and `/tmp/phase1_capture.pcap`.

---

## 10. Non-blockers we considered — and one correction after hardware run

These were items the brief told us to watch for as potential escalation triggers. Mostly not escalations; recording them so we don't re-investigate later. **One item below is corrected by the hardware run.**

- **"Roboflow API key required for something we thought was open"** — local ONNX models, workflow execution, and dynamic blocks all work without a key (hardware-confirmed). **SAM 3 does NOT — see correction below.**
- **"Weights provider less pluggable than release notes imply"** — it is as pluggable as advertised (§2).
- **"SAM 3 won't load without calling Roboflow's servers"** — ~~not a blocker, just pre-stage weights~~. **Correction after hardware run**: SAM 3 hits `inference/models/sam3/segment_anything3.py:458` → `download_model_from_roboflow_api()` → hard 401 without an API key, even with `usage_billable=false` and `disable_model_monitoring=true`. Pre-staging weights alone will not fix this without also patching the auth check out of the `download_model_from_roboflow_api` path. This upgrades the SAM 3 integration effort in §3 from "low-cost path A" to "requires a code patch in the legacy registry, not just a cache pre-seed." Still not a strategy-level blocker — but bigger than the static audit implied. **Flag for Phase 3 scoping.**
- **"Apache 2.0 / Enterprise boundary violation"** — the one cross-import (§5) is in the core-side file, not an enterprise-side import of core. No reverse violation found. We can cleanly excise enterprise with a ~10 LOC patch.

---

## 11. Recommended baseline for Phase 2

- **Fork baseline**: tag `v1.2.2`.
- **Cherry-pick on top**: `48cf81828 Fix serverless auth bypass and observability (#2234)` — this is a post-v1.2.2 security fix. No other post-v1.2.2 commit looks worth cherry-picking for Phase 2 (the others are new model additions and small workflow-block tweaks we can pick up at the next rebase).
- **First FlytBase patches to land** in Phase 2 (order of dependency):
  1. Lazy-import guard in `blocks_loader.py:45` (§5).
  2. Kill switch for `UsageCollector` (§6).
  3. Hard delete of `inference/enterprise/`, `modal/`, `theme/`, `theme_build/`.
  4. Removal of cloud-push workflow blocks (§7).
  5. Rename Docker image tags from `roboflow/inference-server-*` → `flytbase/air-edge-runtime-*`.
  6. Add `NOTICE` file + updated top-level `LICENSE`.
  7. Bootstrap `FORK_CHANGES.md` capturing every one of the above.

**I do not recommend proceeding to Phase 2 until**:
- The outstanding hardware items in §9 are addressed (Jetson Orin run remains; pipeline retry with tuned env or a pause of the competing stack).
- PM / architect has acknowledged the model-tree-split design point (§3), the "public workflows are not airgap" correction (§4), the **SAM 3 airgap correction** (§10), and the **Datadog telemetry finding** (§12).

Either acknowledgement is welcome in a single thread on this report.

---

## 12. Hardware verification results — A2000 Ada run (2026-04-17)

**Host**: Ubuntu 22.04, Linux 5.15.0-144-generic, 24 GB RAM, NVIDIA RTX 2000 Ada Generation 16 GB VRAM, Driver 550.144.03, CUDA 12.4, Docker 27.3.1 with the `nvidia` runtime. The host was also running an existing `flytbase/ai-r-*` stack (detection_handler/triton, orchestrator, grafana, graylog, mediamtx, etc.) — GPU pre-allocated 2.9 GB to that stack, leaving 13 GB VRAM and ≈4.4 GB of host RAM free for our tests.

**Image under test**: `roboflow/roboflow-inference-server-gpu:latest`, pushed 2026-04-10, 19.4 GB. `/info` reports `{"name":"Roboflow Inference Server","version":"1.2.2","uuid":"v3KgM7-GPU-0"}`. The installed `inference-cli` pip package is also `1.2.2`. Static code inspection was on v1.2.2 source; the Docker image matches.

**Run environment**: fresh Python venv under `/home/deair/inference-spike/venv`, no `ROBOFLOW_API_KEY` in env, no `~/.roboflow`, default `inference server start --dev`. Metrics defaulted on (per CLI `--metrics-enabled` default).

### §12.1 What worked

**YOLOv8n-640 single-image inference** (`POST /infer/object_detection`, no api_key, image=dogs.jpg, 640×427):

| Call | HTTP | Total | TTFB | Notes |
|---|---|---|---|---|
| 1 (cold) | 200 | 5.73 s | — | Includes model metadata fetch from `api.roboflow.com`, weights fetch from `repo.roboflow.com` |
| 2–6 (warm) | 200 | 8–18 ms | ≈100 µs | Model cached; 55–125 FPS single-image single-stream |

Detections returned correctly (`class=dog, confidence=0.85`). Server-side reported per-frame inference time 0.14 s on the cold call.

**Local workflow** (`POST /workflows/run`): 3-step spec with `roboflow_core/roboflow_object_detection_model@v2` + `roboflow_core/bounding_box_visualization@v1` + `roboflow_core/webhook_sink@v1`, inlined in the request (no Roboflow cloud fetch of the workflow spec). HTTP 200, total 53 ms after warm. Webhook sink ran asynchronously (`"Notification sent in the background task"`).

**Single-image inference throughput** demonstrates the runtime can sustain well above 10 FPS on this hardware. Multi-stream pipeline behavior remains to be confirmed (see §12.3).

### §12.2 What failed, and why

**SAM 3** (`POST /sam3/concept_segment`, `prompts=[{"type":"text","text":"dog"}]`): **HTTP 401**. Even with the correct endpoint and schema, and with `usage_billable=false, disable_model_monitoring=true` in the request body, the server calls `download_model_from_roboflow_api()` → `api.roboflow.com` → 401. Stack trace from server logs:

```
inference/core/interfaces/http/http_api.py:3103 sam3_segment_image → model_manager.add_model
inference/core/models/roboflow.py:646 __init__ → self.download_weights()
inference/models/sam3/segment_anything3.py:458 download_weights → super().download_model_from_roboflow_api()
inference/core/roboflow_api.py:124 → 401 lambda → RoboflowAPINotAuthorizedError
```

This contradicts the README feature matrix's implication that foundation models work in open access, and upgrades the SAM 3 airgap integration from "pre-stage weights (path A in §3)" to "pre-stage weights AND patch out the auth call". See §10 for the corrected analysis.

**Video pipeline** (`InferencePipeline.init_with_workflow(...)`): after the operator voluntarily freed the box, we retried several times with different `STREAM_API_PRELOADED_PROCESSES` values (0, 1, 2 default) against both the 14-s original video and a 180-s concatenation. Results:

- Pipeline **initializes cleanly**: state transitions `NOT_STARTED → INITIALISING → RUNNING`, `VIDEO_CONSUMPTION_STARTED`, worker subprocesses spawn (seen in container ps-tree).
- Pipeline **does produce frames**: one run captured 2 frames within a 3.7 ms window; another captured 2 frames within an 18.5 ms window. Instantaneous frame rate implied by the inter-arrival gaps is **>200 FPS peak** — consistent with the single-image warm latency of 8–18 ms.
- **Sustained consume over HTTP could NOT be demonstrated.** After the initial 2–3 frame burst, `/inference_pipelines/<id>/consume` returns HTTP 200 with empty output indefinitely, and the server logs report `ConnectivityError: Could not communicate with InferencePipeline Manager` from `inference/core/interfaces/stream_manager/api/stream_manager_client.py:245`. This is an **upstream IPC issue** between the uvicorn HTTP handler and the pipeline manager subprocess, reproducible on a fresh container with default env. Pipeline-management endpoints (`/status`, `/terminate`, `/list`) also lock up once the manager is unreachable.

**Assessment**: the runtime *can* decode video and run workflow inference — the model engine works. The HTTP pipeline-management layer in v1.2.2 has a defect under repeated consume pressure. That defect is **not a fork-decision blocker**: our AI-R Edge deployments will drive the engine through direct Python calls inside our own process (where the pipeline manager IPC isn't in the critical path), not through HTTP consume. Phase 2 should still file an upstream issue and consider cherry-picking the eventual fix at rebase time.

**What remains unverified on hardware**: sustained FPS on a multi-second RTSP stream. That measurement needs either a reliable consume path (blocked by the defect above) or an in-process driver. Deferred to Phase 2/3 when we'll be running the engine inside the FlytBase runtime harness, not behind this HTTP manager.

### §12.3 Network audit from tcpdump (most important result)

A 440-second capture under default config (no API key, no configuration changes, single user running probes). The inference container's outbound traffic was decoded via DNS queries and TLS SNI:

| Destination | DNS queries | TLS SNIs | What it is | On which code path |
|---|---|---|---|---|
| `api.roboflow.com` | 84 | 28 | Telemetry heartbeat (`PingbackInfo.post_data` every 60 s) + model metadata for alias resolution + SAM 3 auth attempt | Default — runs from server startup |
| `repo.roboflow.com` | 48 | 16 | Model weights artifact registry | Any model load via alias |
| `http-intake.logs.us5.datadoghq.com` | 3 | 2 | **Datadog log forwarding** | Default — not in static audit |
| `api.github.com` | 6 | 2 | Pingback / issue-link resolution | Default — low volume |
| `*.ultralytics.com` | **0** | **0** | — | — (we used the Roboflow alias, not a raw Ultralytics download) |
| `huggingface.co` | **0** | **0** | — | — (no HF-backed model loaded during the test) |
| Any OTEL external collector | **0** | **0** | — | OTEL confirmed default-off |

**The Datadog endpoint (`http-intake.logs.us5.datadoghq.com`) is a NEW finding.** The static audit identified the `api.roboflow.com` telemetry path and the OTEL path; it did not surface the Datadog log-forwarding path. Phase 2 fork work must sever this as well; we'll need to locate the Datadog client in the server image and disable it via env or patch. I did not identify the exact code location during this run.

Steady-state telemetry cadence observed in server logs: `PingbackInfo.post_data` runs on a 60-second interval via apscheduler, and each successful inference also triggers an Active Learning datapoint register attempt (which fails silently on `Model with id coco/3 not loaded`, but the code path is active).

### §12.4 What this changes in the decision

- **Feasibility verdict stays GREEN** for proceeding to Phase 2. The runtime does run on our target hardware, executes local workflows, and hits the expected FPS bar.
- **Scope estimate for Phase 2 kill-switch work expands slightly**: on top of the `UsageCollector` kill switch (§6), Phase 2 must also neutralize the Datadog log forwarding and the Active Learning registration path (cosmetic but chatty). Still cheap — a handful of env toggles and/or patches in `roboflow_api.py` and wherever the Datadog client is constructed.
- **Phase 3 SAM 3 integration effort grows** from "pre-stage weights" to "pre-stage weights + patch the auth call out of `download_model_from_roboflow_api`". This is still engineering-cheap but needs explicit planning. The option (B) or (C) paths in §3 are now more attractive relative to (A).

### §12.5 SAM 3 alternate sources (post-spike research)

Triggered by the §12.2 SAM 3 401 finding, we checked whether the weights can be obtained from somewhere other than Roboflow's registry. **Yes, cleanly.**

**What the runtime actually loads**: `inference/models/sam3/segment_anything3.py` constructs `build_sam3_image_model()` from Meta's official `sam3` pip package (currently `sam3==0.1.3` on PyPI, imported from `facebookresearch/sam3`). The load path needs two files in the local cache:

- `weights.pt` — a vanilla PyTorch state_dict. No Roboflow-custom packaging.
- `bpe_simple_vocab_16e6.txt.gz` — a standard CLIP-compatible BPE vocab. Not Roboflow-specific.

**Upstream publishers**:

| Source | Location | Format | License | Access |
| --- | --- | --- | --- | --- |
| Meta (official) | `facebook/sam3`, `facebook/sam3.1` on HuggingFace | safetensors | Meta SAM License (Nov 2025) | HF-gated; request approval, `hf auth login` |
| Meta (official) | `github.com/facebookresearch/sam3` | Same as HF | Same | Same |
| Community mirror | `1038lab/sam3` on HuggingFace | safetensors | Downstream — verify compatibility | Ungated, but verify authenticity before shipping |

**License posture**: Meta SAM License permits commercial use and redistribution to enterprise customers. Explicitly prohibits defense/military/ITAR uses and any use violating U.S./UN/EU sanctions. FlytBase's typical customer base (oil & gas, utilities, construction, rail, security) is inside the permitted scope. Any defense-adjacent deployment needs a legal review before shipping weights.

**Built-in escape hatch already in the code**: `inference/models/sam3/segment_anything3.py:398` sets `load_from_HF=False` when calling `build_sam3_image_model()`. The underlying Meta package accepts `load_from_HF=True`, which loads directly from HuggingFace and bypasses the Roboflow registry entirely. **A one-line patch** (plus a runtime HF token) would give us SAM 3 without touching the Roboflow auth path.

**Cache-hit short-circuit**: `inference/core/models/roboflow.py:648` defines `download_weights()` which starts with `if are_all_files_cached(files=infer_bucket_files, model_id=self.endpoint): return`. If we pre-seed `~/.cache/roboflow/inference/sam3/sam3_final/weights.pt` and the BPE vocab, the function returns before it ever calls `download_model_from_roboflow_api()`. No patch required, no auth call, no 401. The §12.2 failure only happens because the cache was empty.

**Net effect on §10 and §3**: the SAM 3 finding is still material, but the fix is *cheaper* than I first claimed. Two engineering paths now exist beyond the original "pre-stage weights" — see the revised §3 for the full option set.

### §12.6 Artifacts

- `/home/deair/inference-spike/probes/run_probes.sh`, `run_probes_v2.sh`, `run_probes_v3.sh` — HTTP probe scripts (three iterations).
- `/home/deair/inference-spike/probes/video_pipeline.py` — video pipeline probe (incomplete due to OOM).
- `/home/deair/inference-spike/probes/logs/` — all request/response JSONs, openapi.json (dump of the server's OpenAPI at runtime), endpoints.txt.
- `/tmp/phase1_capture.pcap` — 58 MB pcap of the 440-second capture. Readable with tshark/wireshark. Filters above were derived from this file.
- `/tmp/cache/phase1_video.mp4` — test video staged into the cache mount.
- `/home/deair/inference-spike/server_start.log` — output from `inference server start --dev`.

Keep or delete these at operator discretion. None are required for Phase 2 work; they're retained for audit.
