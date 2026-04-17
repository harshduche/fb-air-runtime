# 01 — Scope and Constraints

This doc is the "hard rules" list. If something here conflicts with a
suggestion elsewhere, the rule wins — escalate instead of bending it.

## In scope (what AI-R Edge runtime must do)

1. **Execute AI templates** on edge hardware next to drone docks.
   Targets: x86 + NVIDIA GPU (RTX class, 16 GB+ VRAM preferred), NVIDIA
   Jetson Orin (any variant).
2. **Load template bundles** from:
   - FlytBase Model Hub registry (online path, mutual-TLS authenticated).
   - Pre-staged offline bundles (airgap path, signed).
3. **Run inference** on:
   - Still images posted by the dashboard.
   - RTSP streams from dock cameras.
   - Recorded video files for testing.
4. **Emit results** to:
   - FlytBase One dashboard widgets.
   - Flinks alert/automation event bus.
   - Media archive (annotated frames for post-mission review).
5. **Support multi-template co-tenancy** on a single device (e.g., PPE
   compliance + perimeter intrusion + vehicle count), under admission
   control and priority rules.
6. **Support tenant isolation** — private templates load only on authorized
   devices.
7. **Be rebase-friendly** with upstream Roboflow Inference so we can
   cherry-pick security patches quarterly.

## Out of scope (do NOT build these)

- Training or fine-tuning — templates come from elsewhere (FlytBase ML
  team, partners, customer-supplied).
- A new dashboard — FlytBase One exists; we publish to it.
- A new alert engine — Flinks exists; we publish events to it.
- A general-purpose inference SaaS — this is a private runtime for a
  specific product surface.

## Hard rules

### Licensing and code boundary

1. **`inference/enterprise/` is untouchable.** It is source-available under
   an enterprise license, not Apache 2.0. Our fork must never import from
   it, ship it, or depend on it. Phase 2 deletes the directory.
   - One known core→enterprise cross-import exists in
     `inference/core/workflows/execution_engine/introspection/blocks_loader.py:45`.
     Phase 2 patches this to a lazy guard.
2. **Apache 2.0 compliance** — preserve upstream `LICENSE.core`, add our
   own `NOTICE` crediting Roboflow with upstream link, document every
   modification in `FORK_CHANGES.md` (Phase 2).
3. **Model licenses are separate from runtime license**:
   - **SAM 3**: Meta SAM License (Nov 2025). Commercial use allowed,
     military/ITAR/sanctioned-entity carve-outs. See §5 for how we source
     weights.
   - **YOLO v5/v8**: AGPL unless commercial-licensed.
   - **YOLO v11**: commercial-licensed.
   - Implication: **do not bundle license-ambiguous weights in Docker
     images.** Flag in the model loading path. Source weights per
     deployment context.

### Runtime behavior

4. **No calls to Roboflow's servers at runtime** unless the customer has
   explicitly opted in. Airgap is a hard requirement for On-Prem.
5. **No telemetry leaving the device** without explicit FlytBase routing.
   Phase 2 must neutralize three observed exporters from the spike:
   - `api.roboflow.com` usage tracking (`UsageCollector` singleton).
   - `http-intake.logs.us5.datadoghq.com` log forwarding (new finding from
     the hardware run).
   - `api.github.com` pingback.
   OpenTelemetry is default-off and not a problem.
6. **No sketchy workarounds.** If a path requires calling home and the fix
   looks like a patch-the-auth-check hack, stop and escalate rather than
   shipping it.

### Engineering discipline

7. **Phase gating** — each phase ends with a written deliverable and a
   human review. Do not proceed past a gate on our own.
8. **One-way door discipline** — bundle schemas, signing, auth protocols,
   block manifests all depend on external contracts. Stop and ask before
   committing to any of them. See §5.
9. **Small commits** — every commit one logical change, `[phase-N]`
   subject-line prefix. No Co-Authored-By trailers on this project.
10. **Upstream-rebase-friendly changes** — don't rename things we don't
    need to rename. Don't reformat code we don't need to change.
11. **Document every deviation** — `FORK_CHANGES.md` (Phase 2+) is the
    source of truth for what we changed and why. It is required by
    Apache 2.0 Section 4; it is also load-bearing for our rebase plan.

### Hardware honesty

12. **Never claim to have run hardware-only steps** from a pure static
    inspection. Hardware steps need explicit verification on real devices.
    Jetson Orin validation, in particular, is outstanding — the Phase 1
    spike covered x86 + A2000 Ada only.

## Things that might look like rules but are not

- "Avoid Ultralytics weights" — false. Plan explicitly calls for
  downloading YOLO weights from Ultralytics directly to bypass Roboflow's
  registry. License is the concern (AGPL for v5/v8), not provenance.
- "Never modify upstream code" — false. We do modify it (stripping
  enterprise, adding kill switches, registering our provider). We just
  document every change.
- "No HTTP endpoints" — false. The inference server exposes a REST API
  and we keep it; the dashboard talks to it. The concern is *what* those
  endpoints talk to, not whether they exist.
