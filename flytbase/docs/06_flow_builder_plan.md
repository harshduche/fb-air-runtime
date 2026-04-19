# 06 — FlytBase Flow Builder (plan)

Local, airgap-friendly replacement for the Roboflow cloud iframe at
`/build`. Runs as a sibling route at `/flybuild` during A/B so we can
compare feature-by-feature without ripping out the upstream builder.

**Status**: plan drafted 2026-04-18. Implementation **blocked** until
Phase 2 fork repository exists (per gate discipline in
[02_plan_and_phases.md](02_plan_and_phases.md) §Gate rules). This doc is
the Phase 1 planning artifact.

## Why this exists

Phase 1 discovered that `/build` is a 92-line iframe shell; the actual
workflow editor is served from `https://app.roboflow.com/workflows/local`
(see [03_current_status.md](03_current_status.md) and
[05_key_design_decisions.md](05_key_design_decisions.md) D11). That
breaks the airgap rule in [01_scope_and_constraints.md](01_scope_and_constraints.md)
§4 and hands Roboflow product control over the authoring UX forever.

`/flybuild` fixes both: the editor lives in-container, the workflow
engine underneath is identical, and FlytBase owns the UX roadmap.

## Locked-in decisions

| # | Choice | Rationale |
| --- | --- | --- |
| 1 | **React 18 + React Flow** | Largest ecosystem for node-graph editors. Most workflow-editor precedent uses it. Typescript + Vite. |
| 2 | **Route `/flybuild`** | Short, doesn't clash with `/build`, room for `/flybuild/edit/{id}` children. |
| 3 | **Isolated workflow store** at `$MODEL_CACHE_DIR/workflow/flyt/` | A/B safety — edits in one UI can't corrupt the other. Migration to shared store deferred. |
| 4 | **`ENABLE_FLYT_BUILDER=False` default** | Opt-in while we build. Flip to default-on after MVP ships. |

## Directory layout (fork repo, Phase 2+)

```
inference/core/interfaces/http/flyt_builder/
├── __init__.py
├── routes.py              # FastAPI router — mirrors builder/routes.py shape
├── frontend/
│   ├── src/               # React + TS source
│   ├── public/            # static assets, FlytBase logos from fb-brand-kit
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── dist/              # built artifact, checked in (mirrors landing/out/)
└── README.md              # developer notes for frontend rebuild
```

Upstream-rebase surface is a **single merge hunk** in
`inference/core/interfaces/http/http_api.py`, gated by
`ENABLE_FLYT_BUILDER`. No files in `inference/core/` are modified beyond
that hunk.

## API surface (already exists — verified)

All endpoints are on this server today. No new backend work for the MVP.

| UI concern | Endpoint | Notes |
| --- | --- | --- |
| Block palette | `POST /workflows/blocks/describe` | Returns 175 blocks with full param schemas on this server |
| Schema validation | `GET /workflows/definition/schema` | Workflow JSON schema |
| Dynamic output resolution | `GET /workflows/blocks/dynamic_outputs` | For blocks whose outputs depend on params |
| Execution engine versions | `GET /workflows/execution_engine/versions` | For compatibility pins |
| Workflow save | `POST /flybuild/api/{id}` | New; mirrors `/build/api` handler |
| Workflow load | `GET /flybuild/api/{id}` | New; mirrors `/build/api` handler |
| Workflow list | `GET /flybuild/api` | New; mirrors `/build/api` handler |
| Workflow delete | `DELETE /flybuild/api/{id}` | New; mirrors `/build/api` handler |
| Run workflow | `POST /infer/workflows` | Unchanged upstream endpoint |
| Per-block test (SAM 3) | `POST /sam3/concept_segment` | Unchanged |

The backend routes for `/flybuild/api/*` are near-verbatim copies of
`inference/core/interfaces/http/builder/routes.py`, retargeted at a
different on-disk directory (`workflow/flyt/` vs `workflow/local/`).

## MVP scope (first merge-ready build, ~3–5 eng-days)

Must-haves:

1. Left sidebar: block palette grouped by category (detection, tracking,
   sinks, etc.), search box, drag-to-canvas.
2. Center: React Flow canvas with zoom/pan, node connections, delete
   selected, undo/redo.
3. Right panel: selected-block param editor rendered from the block's
   param schema (string / number / enum / boolean / image-ref / reference
   to another block's output).
4. Top bar: workflow name, Save, Run (against a user-provided still
   image URL or uploaded file), Delete, switch-to-iframe-builder link.
5. Run result: JSON dump in a collapsible panel; no fancy visualization
   yet.
6. Persistence through `/flybuild/api/{id}` (CSRF-protected via same
   token scheme as `/build/api/`).

Explicit non-goals for MVP (deferred to Phase 3+):

- Video preview / frame scrubbing.
- Inline mask / bbox / polygon rendering over images.
- Output type visualizers beyond raw JSON.
- FlytBase brand theming beyond a logo swap.
- Auth — local dev runs with the CSRF token pattern only.
- Template bundle export (depends on D3, still unsigned).

## Phase placement

| Phase | What this plan contributes |
| --- | --- |
| 1 (current) | This doc. |
| 2 (fork + strip) | Create `flyt_builder/` skeleton (empty routes + placeholder `index.html`). One-liner http_api.py hook behind env flag. No UI work. |
| 3 (Model Hub integration) | Full MVP ships. Replaces the iframe for airgap customers. Cloud builder stays available behind `ENABLE_BUILDER=True` for non-airgap devs. |
| 4 (FlytBase blocks) | Visualizers for `flytbase_*` block outputs. Dock/mission metadata panel. |
| 5 (admission control) | Resource-budget hints inline in the editor ("this workflow needs 4 GB VRAM, dock has 2 GB"). |

## Open questions (not blockers for MVP start)

- **Brand theming scope.** MVP ships a logo + accent color from
  `fb-brand-kit/`; full design pass is a Phase 3 item. Who owns the
  design? FlytBase design team or engineers making do with tokens from
  the brand kit?
- **Auth model for non-local deployments.** Today we rely on CSRF +
  localhost. When `/flybuild` is exposed beyond the host, we need real
  auth. Defer to Phase 3 — wires into existing FlytBase auth per D5.
- **Shared vs isolated workflow store — long-term decision.** Isolated
  during A/B. Once `/flybuild` is the default, either (a) migrate
  `workflow/local/*.json` into `workflow/flyt/` and delete `/build`, or
  (b) leave both routes indefinitely for backwards compatibility. Revisit
  at Phase 3 exit.
- **Block param editor — generic vs custom-per-block.** MVP renders all
  params from a generic schema-to-form mapper. Some blocks
  (e.g. `roboflow_core/sam3@v3`) want richer UX — image-on-canvas prompt
  selection, text-prompt autocompletion. Phase 3 decision.

## Risks

| Risk | Mitigation |
| --- | --- |
| React Flow's canvas doesn't fit a >100-block workflow | MVP enforces soft limit ~50 blocks; show perf warning. Re-evaluate at Phase 4. |
| Block schemas drift faster than we can keep UI in sync | MVP uses generic schema-to-form so new blocks "just work" with no UI change. Pay the cost only when a block needs bespoke UX. |
| Developers expect feature parity with cloud builder on day one | Top-bar link back to iframe builder is always available. README explains "FlytBase builder is local/airgap-only; use iframe for advanced features during transition." |
| Bundled JS pushes Docker image over current 19.4 GB | React + React Flow production bundle is <500 KB gzipped. Negligible. |

## Not in scope for this document

- **D3 (template bundle format)** — separate doc, pending PM review.
- **D4 (bundle signing)** — separate doc, pending security review.
- **Training pipeline** — explicit non-goal (see `01_scope_and_constraints.md` §Out of scope).
- **Dashboard / Flinks wiring** — those are workflow *blocks*, not
  builder-UI features. Covered in Phase 4.

## Sign-off needed before implementation

- Architect: confirms `/flybuild` route naming, React stack choice,
  single-hunk upstream-rebase seam.
- PM: confirms scope of MVP (features above) is enough to demo airgap
  authoring and defer deep features.

Implementation can begin the day the fork repo (Phase 2) exists; until
then this plan is the contract.
