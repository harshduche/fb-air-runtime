# 02 — Plan and Phases

Six phases, each with a hard gate at the end. Do not start phase N+1
until phase N's deliverable is written and human-reviewed.

## Phase 1 — Feasibility spike (2 days)

**Goal**: decide whether forking is the right foundation, before we
commit to the integration work.

**Deliverable**: written report (`flytbase/phase_1_feasibility_spike.md`)
covering weights-provider pluggability, API-key gating, outbound-URL
inventory, telemetry defaults, enterprise boundary, and SAM 3 path.
Honest assessment of whether the fork is viable.

**Status**: **done**, pending PM/architect review. See
[03_current_status.md](03_current_status.md).

## Phase 2 — Fork and strip (1 week)

**Goal**: a clean FlytBase-branded fork repository with enterprise,
cloud-only, and irrelevant modules removed.

**Work items** (in dependency order):

1. Create `flytbase/air-edge-runtime` repository.
2. Add licensing files: keep `LICENSE.core`, add `NOTICE` crediting
   Roboflow, add top-level `LICENSE` describing Apache 2.0 + FlytBase
   licensing for our additions.
3. Baseline at upstream tag `v1.2.2`, cherry-pick
   `48cf81828 Fix serverless auth bypass and observability (#2234)` as a
   post-v1.2.2 security fix.
4. Patch `inference/core/workflows/execution_engine/introspection/blocks_loader.py:45`
   to a lazy enterprise import guarded by `LOAD_ENTERPRISE_BLOCKS`.
   Single-file, ~10 lines.
5. Add explicit kill switches for the three observed telemetry exporters:
   - `UsageCollector` (env flag, default off).
   - Datadog log forwarding (env flag, default off). Need to locate the
     Datadog client in the image — Phase 2 exploration task.
   - GitHub pingback.
6. Hard-delete: `inference/enterprise/`, `modal/`, `theme/`, `theme_build/`.
7. Remove cloud-push workflow blocks:
   `inference/core/workflows/core_steps/sinks/roboflow/dataset_upload/v1.py`,
   `.../v2.py`, `.../model_monitoring_inference_aggregator/v1.py`,
   plus `inference/core/active_learning/`.
8. Rename Docker image tags `roboflow/inference-server-*` →
   `flytbase/air-edge-runtime-*`. Keep container interface identical.
9. Bootstrap `FORK_CHANGES.md` with every change from (1)–(8).
10. Set up CI: GitHub Actions (or equivalent) building Docker images for
    x86 and aarch64, running Phase 1 smoke tests.

**Deliverable**: `flytbase/air-edge-runtime` repo with Docker images
building on CI for both architectures, Phase 1 smoke tests passing on the
stripped codebase, `FORK_CHANGES.md` committed.

## Phase 3 — Model Hub integration (3–4 weeks)

**Goal**: runtime pulls templates (model weights + workflow specs +
post-processing config) from FlytBase Model Hub instead of Roboflow's
registry. The main integration work.

**Work items**:

1. **Template bundle format** — design schema. One-way door: stop and
   ask before finalizing. Proposed layout (subject to PM review):
   ```
   template_name_v1.2.0.flyttmpl/
   ├── manifest.yaml           # metadata, version, hardware reqs, license
   ├── model/
   │   ├── weights.onnx        # or .engine for TensorRT
   │   └── config.yaml         # inference configuration
   ├── postprocess/
   │   └── workflow.json       # Roboflow Workflow spec format
   ├── widget/
   │   └── dashboard.json      # FlytBase widget definition
   ├── alerts/
   │   └── rules.yaml          # default alert rules
   ├── fixtures/
   │   ├── test_inputs/
   │   └── expected_outputs/
   └── card/
       └── performance.md
   ```
2. **FlytBase weights provider** — register via upstream's
   `register_model_provider("flytbase", handler)` API. Handler signature
   is `(model_id, api_key, **kwargs) -> ModelMetadata`. Small function;
   see §2 of the spike report for the verified interface.
3. **Workflow spec adapter** — translate/augment bundle's `workflow.json`
   into the execution engine's expected format.
4. **Airgap delivery path** — On-Prem customers: signed offline bundles
   delivered via existing On-Prem update infrastructure. Weights provider
   supports both online and offline modes, controlled by config.
5. **Version rollback** — runtime can load multiple versions of a
   template simultaneously (shadow-mode testing) and roll back instantly.
6. **Tenant isolation** — private templates only loadable by authorized
   devices. Wire into existing FlytBase auth; do not invent new auth.
7. **SAM 3 airgap plan**: pre-stage Meta-sourced weights in the bundle +
   cache-hit short-circuit (see [05_key_design_decisions.md](05_key_design_decisions.md)).

**Deliverable**: template bundle schema (reviewed, signed off), working
FlytBase weights provider with tests, adapter with tests, airgap delivery
verified by disconnecting the network, version rollback demo.

## Phase 4 — FlytBase workflow blocks (4–6 weeks)

**Goal**: custom workflow blocks that wire runtime output into FlytBase
One dashboard, Flinks alerts, and operational context.

**Work items**:

1. Build five+ custom blocks (via upstream's `create_workflow_block`
   docs):
   - `flytbase_dashboard_widget_sink` — formats detections per widget,
     pushes to dashboard.
   - `flytbase_flink_alert_publisher` — publishes alert events to Flinks.
   - `flytbase_dock_context_enricher` — annotates every detection with
     dock/mission/drone/GPS/timestamp metadata.
   - `flytbase_geofence_filter` — filters detections by zone polygons.
   - `flytbase_media_archive_sink` — writes media + overlays for
     post-mission review.
2. Wire blocks into the workflow spec adapter so templates reference them
   by name.
3. **Per-block performance budget**: none should add more than **5 ms
   latency per frame at steady state**.

**Deliverable**: 5+ blocks with unit + integration tests, documentation,
end-to-end demo (template loads → runs YOLO + custom post-proc →
publishes to Flinks → renders widget in FlytBase One).

## Phase 5 — Admission control and resource management (2–3 weeks)

**Goal**: multi-template, multi-dock resource management. Prevent
overcommit, handle priority, enforce VRAM budgets.

**Work items**:

1. **Resource budget manager** — tracks GPU VRAM, CPU memory, concurrent
   stream count.
2. **Template assignment validation** — at deploy time, check whether
   the device has headroom for the new template; block with a clear
   operator-facing error if not.
3. **Priority ordering** — high-priority templates can evict or
   time-slice lower-priority ones.
4. **SAM 3 co-tenancy** — SAM 3 claims ~4 GB VRAM. Other templates must
   adapt (time-slice or refuse concurrent load). Policy configurable
   (strict/permissive).

**Deliverable**: budget manager with tests, admission control wired in,
priority and co-tenancy working in integration tests, operator-facing
error messages that explain blockers clearly.

## Phase 6 — Production hardening (ongoing)

- Security audit: all input paths, workflow spec parsing, weights
  verification.
- Fuzz testing on the REST API.
- Stress testing: 4 concurrent streams, 6 templates loaded, 24 hours
  without memory leak or FPS degradation.
- Operator runbook, troubleshooting guide, upgrade procedure.
- Upstream rebase procedure: quarterly cherry-pick of security patches.
- Prometheus metrics for dashboards.

**Deliverable**: production-grade release + ongoing operational
discipline.

## Gate rules

- **Do not start phase N+1 before phase N's deliverable is committed and
  reviewed.** The spike is explicitly a decision gate; each subsequent
  phase also has one.
- **Stop mid-phase and escalate** on:
  - License violations or ambiguity.
  - Required auth path hitting Roboflow servers where we thought it
    wouldn't.
  - TensorRT conversion failing on Jetson in a way that suggests the
    architecture isn't portable.
  - Any hint the Apache 2.0 core / Enterprise boundary is being crossed.
- **Do not work around legal or architectural blockers.** Write up what
  you found, push the branch, wait for human review.
