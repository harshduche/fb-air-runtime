# 00 — Context: Why We Are Forking Roboflow Inference

## FlytBase and the Edge Compute Suite

FlytBase is a drone autonomy platform. Customers are enterprise operators
running autonomous drone fleets — oil & gas, utilities, construction, rail,
and security. A defining trait of this customer segment: they have clear
computer-vision use cases (count rail wagons, detect perimeter intrusion,
check PPE compliance), but they **do not have in-house ML teams**. The
product strategy must not assume they do.

The **Edge Compute Suite** is FlytBase's answer. It's three modules:

1. **AI-R Edge** — the template execution runtime. Runs AI templates
   on edge hardware next to drone docks. **This is what we are building.**
2. **EdgeGuard** — drone-aware firewalls.
3. **On-Prem** — airgapped enterprise deployments.

All three share an operating premise: **the customer should not need ML
expertise to benefit from ML features.** They buy and deploy templates.

## What a "template" is

A template is a versioned, pre-built AI bundle containing:

- Trained model weights (ONNX or TensorRT engine).
- Inference config (input resolution, preprocessing, thresholds).
- Post-processing logic (tracking, counting, zone filtering).
- A dashboard widget definition (how results render in FlytBase One).
- Default alert rules (wired into Flinks — FlytBase's alert/automation
  framework).
- Test fixtures (input images/videos + expected outputs for acceptance).
- A model card with performance expectations.
- A manifest describing all of the above and the hardware requirements.

Templates come from three sources: first-party (FlytBase ML team),
partner (certified third parties), and customer-private (customer's own
fine-tuned models delivered under their tenant).

**The runtime's job** is to:
1. Read a manifest.
2. Pull the model weights (from the FlytBase Model Hub, or from a
   pre-staged offline bundle for airgap customers).
3. Compile weights for the target hardware (x86 CUDA / Jetson TensorRT).
4. Wire up post-processing.
5. Expose results in the format expected by the FlytBase dashboard and
   alert systems.

## Why fork, rather than build

Building the template runtime from scratch was estimated at **12+ months**.
`github.com/roboflow/inference` (the Apache 2.0 core) already provides:

- Model support for the current generation of open-weights CV:
  YOLO v5/v7/v8/v10/v11/v12, RT-DETR, SAM 3, CLIP, Florence-2, DINOv3,
  Moondream, and more.
- A 100+ block **Workflow engine** (compose detection → post-processing
  → sinks declaratively, with a first-class extension path for custom
  blocks).
- Video stream management (RTSP, file, webcam, WebRTC).
- Hardware acceleration (CUDA, TensorRT, Jetson-specific builds).
- A **pluggable weights provider abstraction** with an explicit
  `register_model_provider()` public API — verified during the Phase 1
  spike; see §2 of the spike report.
- A REST + WebRTC API the dashboard can call.

Forking + adapting is weeks-to-months, not a year. We pay for this speedup
with:

- A **maintenance tax** (we rebase quarterly on upstream security patches).
- An **attention tax** on license boundaries (Roboflow ships a mixed
  Apache + source-available codebase; we must stay clean of the latter).
- **Telemetry neutralization work** (upstream phones home by default; we
  have to sever those paths for airgap customers).

The Phase 1 spike confirmed these taxes are affordable.

## What we add on top

Things the upstream does not do, that FlytBase must add:

- **Model Hub integration** — pull templates from FlytBase's registry with
  mutual-TLS auth, cache locally, support offline bundles for On-Prem.
- **Dashboard and alert wiring** — custom workflow blocks that publish
  detections to FlytBase One widgets and Flinks alert routing.
- **Dock/mission context** — every detection carries dock ID, mission ID,
  drone ID, GPS, timestamp, so downstream systems can correlate events.
- **Geofence filtering** — many drone use cases need operator-defined
  zones (do/don't alert inside this polygon).
- **Admission control** — one AI-R Edge device serves one dock, but may
  run multiple templates (PPE + intrusion + vehicle count). Without
  admission control, stacking a 4 GB SAM 3 template on a 2 GB YOLO
  template OOMs the GPU.
- **Tenant isolation** — private templates must only be loadable by
  devices in the owning tenant. Wired into existing FlytBase auth.
- **Airgap delivery** — On-Prem customers with no outbound internet must
  receive signed offline bundles via FlytBase's existing On-Prem update
  channel.

## Why this matters for decisions

Several downstream calls hinge on the business context above:

- **We cannot accept any runtime call to Roboflow's servers.** Airgap is a
  hard requirement for On-Prem. Features that only work with a Roboflow
  API key must be either replaced or cleanly stripped.
- **Rebase tax is the long-term budget constraint.** Gratuitous renames,
  reformats, or reorganizations are expensive. Patches we upstream
  (cache-first short-circuits, feature flags) pay us back over time.
- **We ship to enterprise customers under a commercial product**. Model
  licenses (Meta SAM, Ultralytics YOLO AGPL vs. commercial) flow through
  to what we can bundle. Flagged in §5 design decisions.
- **Customers don't have ML teams**, so the template abstraction must hide
  everything below the manifest. The runtime is an implementation detail;
  operators see templates, not model IDs.

## One-sentence mission

Deliver an Apache 2.0-compliant, airgap-capable template execution runtime
on edge hardware (x86 GPU and Jetson Orin), built by forking and adapting
Roboflow Inference, integrated with FlytBase Model Hub / FlytBase One /
Flinks, within six gated phases.
