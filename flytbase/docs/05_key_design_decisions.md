# 05 — Key Design Decisions

A running list of one-way-door calls. Each entry: what the decision is,
why it matters, current stance, and who needs to sign off.

## D1 — Phase 1 baseline tag

**Decision**: fork baseline is upstream tag `v1.2.2`, plus one cherry-pick
of commit `48cf81828 Fix serverless auth bypass and observability (#2234)`.

**Why it matters**: this is the quarterly-rebase anchor. Future rebases
measure drift from this point. Picking a different baseline now means
re-inspecting all of Phase 1's static findings.

**Stance**: settled. Committed on branch `phase-1-spike`.

**Sign-off needed**: none (reversible if Phase 2 decides otherwise).

---

## D2 — Enterprise boundary approach

**Decision**: delete `inference/enterprise/` in Phase 2. Guard the one
cross-import at
`inference/core/workflows/execution_engine/introspection/blocks_loader.py:45`
with a lazy import inside a `LOAD_ENTERPRISE_BLOCKS` flag (the flag is
already imported on line 12; only the module-level import needs to
become conditional).

**Why it matters**: enterprise code is source-available (not Apache 2.0).
Shipping any part of it would violate the upstream enterprise license.

**Stance**: plan settled. Implementation in Phase 2.

**Sign-off needed**: none.

---

## D3 — Template bundle format (`.flyttmpl`)

**Decision**: **NOT YET MADE.** Proposed layout in
[02_plan_and_phases.md §Phase 3](02_plan_and_phases.md#phase-3--model-hub-integration-34-weeks).

**Why it matters**: this is a true one-way door. Once partners and
customer-private templates are built against this schema, changing it
becomes a migration project. Every field name, every default value,
every directory convention.

**Stance**: proposal drafted, awaiting PM review. Implementation blocked
until sign-off. As of 2026-04-25 the flow builder ships an interim **v0
slice** (workflow spec + manifest + README only — no model weights,
widgets, alerts, fixtures, card) under `schema_version: "flyttmpl/v0"`,
documented in [10_flyttmpl_v0_schema.md](10_flyttmpl_v0_schema.md). v0
is explicitly an iteration anchor, not a substitute for D3 sign-off.

**Sign-off needed**: PM, architect, at least one partner team that will
ship a template. Customer ML teams that will produce private templates
should also see this before it's locked.

---

## D4 — Bundle signing scheme

**Decision**: **NOT YET MADE.**

**Why it matters**: prevents tampered templates from loading. Signing
algorithm, key distribution, certificate hierarchy, and revocation
policy are all one-way-door choices. A bad signing scheme either (a)
doesn't actually protect against tampering, or (b) locks us into
incompatible tooling for years.

**Stance**: Phase 3 task. Propose options for review; don't pick one
without security team sign-off.

**Sign-off needed**: security team, PM, architect. Must also align with
whatever FlytBase On-Prem signs its existing offline update bundles with.

---

## D5 — Tenant isolation

**Decision**: wire into **existing** FlytBase auth. Do not invent new
auth.

**Why it matters**: multiple auth systems = security posture nightmare.

**Stance**: plan settled. Implementation in Phase 3 (Model Hub
integration).

**Sign-off needed**: security team (to confirm the existing auth handles
per-device-per-tenant scoping at the granularity we need).

---

## D6 — SAM 3 airgap strategy (updated after Phase 1 hardware run)

**Decision**: combine (a) **pre-stage Meta-sourced SAM 3 weights** in the
template bundle, so the cache is primed before the runtime tries to fetch
from Roboflow, with (b) **cache-hit short-circuit** — relies on the
existing early-return at `inference/core/models/roboflow.py:663` so the
auth call is skipped when weights are already cached. Keep
`load_from_HF=True` at `inference/models/sam3/segment_anything3.py:398`
as a secondary escape hatch for development ergonomics.

**Why it matters**: the Phase 1 hardware run confirmed that SAM 3 on the
default path calls `download_model_from_roboflow_api()` → 401 without an
API key, even with `usage_billable=false` and
`disable_model_monitoring=true`. Without the cache pre-staging,
foundation-model templates cannot run airgap.

**Where the weights come from**: Meta publishes SAM 3 weights on
HuggingFace (`facebook/sam3`, `facebook/sam3.1`). The repos are gated —
request access, then `hf auth login`. Format is safetensors. The
underlying `sam3` pip package (Meta's official) already handles loading
from either a local checkpoint or HF; Roboflow wraps this package
without modifying its architecture expectations.

**License**: Meta SAM License (Nov 2025). Permits commercial use and
redistribution. Prohibits military, ITAR, weapons, nuclear, espionage,
and sanctions-violating uses. FlytBase's primary customer segments are
inside the permitted scope. **Any defense-adjacent deployment requires
legal review before shipping weights.**

**Stance**: settled, pending legal sign-off on the Meta SAM License.

**Sign-off needed**: legal (license compliance), PM (decision to use
Meta upstream vs. negotiate with Roboflow for commercial redistribution
rights).

---

## D7 — Telemetry kill switches

**Decision**: Phase 2 adds explicit off-switches for three exporters
that currently default to on:

1. `UsageCollector` — sends usage to `api.roboflow.com` every 60 s.
   Respects `METRICS_COLLECTOR_BASE_URL` env override but has no
   feature flag for "off". Phase 2 adds one.
2. Datadog log forwarding to `http-intake.logs.us5.datadoghq.com`.
   Location in the image unknown; Phase 2 exploration task.
3. GitHub pingback to `api.github.com`. Low volume; same kill switch.

OpenTelemetry is **not** in this list — it defaults to off
(`OTEL_TRACING_ENABLED=False`) and to `localhost:4317` when enabled.
Phase 2 leaves it alone. Phase 3+ may optionally point it at a FlytBase
collector.

**Why it matters**: "no telemetry leaving the device" is a hard rule.
Any runtime call to a non-FlytBase-controlled endpoint is a compliance
risk for On-Prem customers.

**Stance**: settled for Phase 2.

**Sign-off needed**: none (reversible — if FlytBase decides to opt into
aggregated usage stats later, the kill switch just gets a default flip).

---

## D8 — Model tree split handling

**Decision**: not decided whether Phase 3 integrates with both model
trees simultaneously (`inference_models/` new + `inference/models/`
legacy) or migrates everything to one. Current lean: support both via
separate provider mechanisms.

**Why it matters**: SAM 3 and several other models live in the legacy
tree. The legacy tree's weight loader doesn't use the
`register_model_provider` abstraction. If we only integrate with the new
tree, SAM 3 (and similar) can't flow through the FlytBase weights
provider cleanly.

**Stance**: evaluate during Phase 3 planning. Three options:
- A: pre-stage legacy-tree weights in the cache directory during image
  build. Tight coupling to cache paths but zero code changes.
- B: patch the legacy registry to consult our FlytBase provider first.
  More invasive, higher rebase tax.
- C: write a second provider shim that intercepts the legacy path. Most
  code, cleanest long-term.

**Sign-off needed**: architect before Phase 3 starts.

---

## D9 — Pipeline execution mode

**Decision**: AI-R Edge runtime drives the inference engine
**in-process** (direct Python calls), not via the upstream HTTP-managed
pipeline.

**Why it matters**: Phase 1 hardware validation surfaced an IPC defect in
upstream v1.2.2 where `/consume` returns empty after the first frame
burst. The HTTP-managed pipeline is an upstream convenience, not a
load-bearing feature for us. Our runtime has its own lifecycle and
doesn't need the HTTP surface.

**Stance**: settled for Phase 2/3. File an upstream issue about the IPC
defect; cherry-pick the fix at a future rebase.

**Sign-off needed**: none.

---

## D10 — Model license flagging in the loader

**Decision**: add an explicit license-awareness check in the model
loading path. If a template requests a model whose weights are under a
license incompatible with the customer's deployment (e.g., AGPL YOLOv8
at a customer without a commercial license agreement), fail to load with
a clear operator-facing error.

**Why it matters**: bundling license-ambiguous weights into a Docker
image is the fast path to a licensing incident. The runtime is the last
line of defense.

**Stance**: plan for Phase 3 or 4 (at the template-manifest layer).

**Sign-off needed**: legal must define the license-compatibility matrix
(AGPL / commercial-licensed / Meta SAM / Apache / etc.) that the
runtime checks against.

---

## D11 — Flow builder strategy

**Decision**: build a FlytBase-owned workflow builder (`/flybuild`) as
a React SPA served in-container. Keep Roboflow's `/build` iframe
available during A/B; retire it when `/flybuild` reaches parity.

**Why it matters**: Phase 1 found that upstream `/build` is a 92-line
shell that iframes `https://app.roboflow.com/workflows/local`. That
violates the airgap rule in [01_scope_and_constraints.md](01_scope_and_constraints.md)
§4 (no runtime calls to Roboflow servers), hands Roboflow product
control over our authoring UX, and has no path to working in On-Prem
environments with no outbound internet. Three alternatives were on the
table:

- **A (chosen)**: build a minimal FlytBase builder on top of the
  already-Apache-2.0 workflow engine APIs.
- **B**: snapshot and self-host Roboflow's builder SPA. Rejected —
  their cloud SPA is almost certainly not Apache 2.0 (only the
  inference server is), and we'd pay ongoing licensing + rebase cost
  on a UI we don't control.
- **C**: skip a visual builder entirely; author workflows as JSON.
  Rejected for operator-facing product reasons — customers deploying
  templates won't hand-edit JSON. Still supported as the API surface.

**Stance**: settled. Plan in [06_flow_builder_plan.md](06_flow_builder_plan.md);
MVP implementation begins under `inference/core/interfaces/http/flyt_builder/`
behind `ENABLE_FLYT_BUILDER=False` default.

**Sign-off needed**: architect (confirms React stack and single-hunk
upstream-rebase seam at `http_api.py`), PM (confirms MVP scope is
enough to demo airgap authoring).

---

## How to update this document

When a new one-way door appears:

1. Add an entry with ID `D<next>`. Do not renumber existing entries.
2. Fill in all four sections (decision, why, stance, sign-off).
3. If "stance" is **NOT YET MADE**, do not start implementation work
   that depends on it.
4. When a decision is locked in, update the stance line to "settled as
   of `<date>` — see `<commit>` / `<PR>`".
