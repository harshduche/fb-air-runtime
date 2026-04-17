# 04 — Capabilities: What's Possible

Two tables: what the upstream fork gives us for free, and what we must
add to make this a FlytBase product.

## A. Inherited from upstream (works out of the box, Phase 1-verified)

| Capability | Evidence | Airgap-ready after Phase 2? |
| --- | --- | --- |
| **Server boots with no Roboflow API key** | Phase 1 hardware run; fresh venv, no `~/.roboflow`, no env vars. | Yes, once telemetry exporters are neutralized (Phase 2 kill switches). |
| **Local pre-trained ONNX inference** (YOLO v5/v7/v8/v10/v11/v12, RT-DETR) | YOLOv8n-640 warm 8–18 ms/call. Works via alias resolution. | Yes, with pre-staged weights and cache-first short-circuit. |
| **Foundation models** (CLIP, Florence-2, DINOv3, Moondream, OwlV2, etc.) | In `inference_models/inference_models/models/`. HF-backed or local ONNX. | Yes, with pre-staged HuggingFace cache. |
| **SAM 3 text/visual segmentation** | Meta's official model. Code works with correct prompt schema. | Yes, **requires** pre-staged weights (cache-hit bypasses auth) or `load_from_HF=True` flag. See §5. |
| **Workflow engine** (100+ blocks, declarative composition) | Inline workflow round-trip in 53 ms warm on A2000 Ada. | Yes, with a FlytBase workflow-spec loader replacing the Roboflow cloud spec loader. |
| **Dynamic Python blocks** (run arbitrary Python inside a workflow) | Upstream feature; Phase 1 did not exercise but confirmed present. | Yes (sandbox is separate from the API-key check). |
| **Video ingestion** (RTSP, local files, WebRTC, webcam, device indices) | Pipeline engine in `inference/core/interfaces/stream/`. Phase 1 confirmed pipeline initializes + produces frames. | Yes, but sustained HTTP consume is blocked by an upstream IPC defect in v1.2.2. We drive the engine in-process instead. |
| **Hardware acceleration** — CUDA, TensorRT, Jetson builds | NVIDIA runtime registered; x86 image 19.4 GB. Jetson image variants published by upstream. | Yes for x86 (verified). Jetson Orin still to verify. |
| **Per-model Jetson/CUDA environment matching** | `ServerEnvironmentRequirements` and `JetsonEnvironmentRequirements` in `ModelMetadata`. Inherits for free. | Yes — compatibility selection is already modeled. |
| **Pluggable weights provider** | `register_model_provider(name, handler)` is a public API with a `local_file_provider` example in the docstring. | Yes — this is the Phase 3 attach point for FlytBase Model Hub. |
| **Workflow block plugin discovery** | `WORKFLOWS_PLUGINS` env var + entrypoints mechanism. | Yes — Phase 4 FlytBase blocks register through the same seam. |
| **Serverless auth bypass fix** (post-v1.2.2 cherry-pick) | `48cf81828 Fix serverless auth bypass and observability (#2234)`. | Yes, via cherry-pick in Phase 2. |

## B. Must be built by FlytBase

| Capability | Phase | Why upstream doesn't cover it |
| --- | --- | --- |
| **Template bundle format** (.flyttmpl) | 3 | Roboflow's registry fetches raw model artifacts; our template is a bundle (model + workflow + widget + alerts + fixtures + card). |
| **FlytBase weights provider** | 3 | Straightforward — registers via `register_model_provider("flytbase", ...)`. Phase 1 verified the interface. |
| **FlytBase workflow spec loader** | 3 | Replaces `inference/core/roboflow_api.py:884-983 get_workflow_specification`. Loads from Model Hub, not from `api.roboflow.com`. |
| **Airgap offline bundle delivery** | 3 | On-Prem customers have no outbound internet. Uses existing FlytBase On-Prem update channel. |
| **Bundle signing + verification** | 3 | Prevents tampered templates from loading. One-way door — schema and signature algorithm need design review. See §5. |
| **Version rollback** | 3 | Multiple versions loaded simultaneously (shadow-mode) plus instant rollback. Upstream cache is not version-aware by default. |
| **Tenant isolation** | 3 | Private templates only load on authorized devices. Wires into existing FlytBase auth. |
| **`flytbase_dashboard_widget_sink` workflow block** | 4 | FlytBase One is ours; upstream can't ship a block that talks to it. |
| **`flytbase_flink_alert_publisher` workflow block** | 4 | Flinks is ours. |
| **`flytbase_dock_context_enricher` workflow block** | 4 | Dock/mission/drone/GPS metadata is ours. Detections without this context can't be correlated downstream. |
| **`flytbase_geofence_filter` workflow block** | 4 | Operator-defined zones. Many drone use cases need zone-based logic. |
| **`flytbase_media_archive_sink` workflow block** | 4 | Writes annotated media to FlytBase's media archive for post-mission review. |
| **Resource budget manager** | 5 | One device + multiple templates. VRAM, CPU, concurrent-stream budgeting. |
| **Template assignment admission control** | 5 | Clear operator-facing errors like "dock-07 needs 4 GB VRAM, only 2 GB available — uninstall another template or upgrade hardware." |
| **Priority ordering and template eviction** | 5 | High-priority safety templates can evict lower-priority ones. |
| **SAM 3 co-tenancy policy** | 5 | SAM 3 claims ~4 GB VRAM; concurrent-load policy configurable (strict/permissive). |
| **Kill switches for telemetry exporters** | 2 | `UsageCollector` (api.roboflow.com), Datadog log forwarding, GitHub pingback. All default-on upstream. |
| **Stripped cloud-push blocks** | 2 | `roboflow_dataset_upload` v1/v2, `model_monitoring_inference_aggregator`, active learning. All opt-in and safe to delete. |

## C. Won't be built (out of scope)

- Training / fine-tuning.
- Dashboard (FlytBase One exists).
- Alert engine (Flinks exists).
- General-purpose inference SaaS.
- Roboflow's own cloud features: private workflow registry, dataset
  management, model monitoring UI, universe model marketplace.

## Performance envelope (observed)

Measured on NVIDIA RTX 2000 Ada Generation (16 GB VRAM), Ubuntu 22.04,
CUDA 12.4, Docker 27.3.1. Baseline for comparison; Jetson numbers
outstanding.

| Metric | Value | Notes |
| --- | --- | --- |
| Single-image YOLOv8n-640 cold | 5.7 s | Includes model metadata + weights fetch |
| Single-image YOLOv8n-640 warm (P50) | ~10 ms | Model cached |
| Single-image YOLOv8n-640 warm (P95) | ~18 ms | Over 5 consecutive warm calls |
| Implied single-stream FPS ceiling (YOLOv8n-640, inference only) | 55–125 | Depends on P50 vs P95 |
| Local inline workflow (detect + viz + async webhook) | 53 ms warm | HTTP round-trip included |
| Pipeline instantaneous frame gap | 3.7–18.5 ms | >200 FPS peak, bursty measurement |
| VRAM used by YOLOv8n pipeline | ~400 MB | Small model; SAM 3 would be ~4 GB |

## What this gives you — in practice

- **Day 1 of Phase 2**: a working AI-R Edge runtime Docker image that runs
  single-image and workflow inference offline, on x86 GPU, with no calls
  to Roboflow or any other external host.
- **End of Phase 3**: template bundles pulled from FlytBase Model Hub (or
  pre-staged offline), executing workflows including SAM 3 airgap via
  pre-staged Meta weights.
- **End of Phase 4**: detections flowing to FlytBase One widgets and
  Flinks alerts with dock/mission context attached.
- **End of Phase 5**: operators deploy multiple templates per dock with
  clear resource-budget feedback, SAM 3 co-tenancy handled, priority
  eviction on demand.
- **Phase 6+**: production-hardened, quarterly upstream rebase, Prometheus
  metrics, operator runbooks.
